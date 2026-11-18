package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// UploadResult is the metadata Discord returns for a successful attachment.
type UploadResult struct {
	MessageID    string
	AttachmentID string
	URL          string
	ExpiresAt    int64
}

type botState struct {
	remaining    int
	resetAt      time.Time
	blockedUntil time.Time
	healthy      bool
}

// DiscordClient owns bot rotation and header-driven rate limiting. Bucket
// sizes are never hardcoded; we trust X-RateLimit-* from each response.
type DiscordClient struct {
	mu           sync.Mutex
	bots         []Bot
	states       map[string]*botState
	channelLocks map[string]chan struct{}
	cursor       int
	apiBase      string
	timeout      time.Duration
	client       *http.Client
}

func NewDiscordClient(bots []Bot, timeout time.Duration) *DiscordClient {
	states := make(map[string]*botState, len(bots))
	channelLocks := make(map[string]chan struct{})
	for _, bot := range bots {
		states[bot.ID] = &botState{remaining: 1, healthy: true}
		if bot.ChannelID != "" {
			channelLocks[bot.ChannelID] = make(chan struct{}, 1)
		}
	}
	return &DiscordClient{
		bots:         bots,
		states:       states,
		channelLocks: channelLocks,
		apiBase: strings.TrimRight(envOr("DISCORD_API_BASE", "https://discord.com/api/v10"), "/"),
		timeout: timeout,
		client:  &http.Client{Timeout: timeout},
	}
}

func (d *DiscordClient) Pick() (Bot, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.bots) == 0 {
		return Bot{}, errors.New("no Discord bots configured")
	}
	for i := 0; i < len(d.bots); i++ {
		index := (d.cursor + i) % len(d.bots)
		bot := d.bots[index]
		if d.states[bot.ID].healthy {
			d.cursor = (index + 1) % len(d.bots)
			return bot, nil
		}
	}
	return Bot{}, errors.New("no healthy Discord bots available")
}

// channelLock serialises writes to one Discord channel, complementing the
// per-bot rate state. One channel per bot is the intended configuration.
func (d *DiscordClient) channelLock(channelID string) chan struct{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.channelLocks[channelID]
}

// acquire waits until a bot is allowed to make another request.
func (d *DiscordClient) acquire(bot Bot) error {
	d.mu.Lock()
	state := d.states[bot.ID]
	if state == nil {
		d.mu.Unlock()
		return fmt.Errorf("unknown bot %s", bot.ID)
	}
	wait := time.Duration(0)
	now := time.Now()
	if state.blockedUntil.After(now) {
		wait = state.blockedUntil.Sub(now)
	}
	if state.remaining <= 0 && state.resetAt.After(now) && state.resetAt.Sub(now) > wait {
		wait = state.resetAt.Sub(now)
	}
	d.mu.Unlock()

	if wait > 0 {
		if wait > 60*time.Second {
			return errors.New("Discord rate-limit wait too long")
		}
		time.Sleep(wait + 25*time.Millisecond)
	}
	return nil
}

func (d *DiscordClient) observe(bot *Bot, resp *http.Response) {
	d.mu.Lock()
	defer d.mu.Unlock()
	state := d.states[bot.ID]
	if state == nil {
		return
	}
	if remaining, err := strconv.Atoi(resp.Header.Get("X-RateLimit-Remaining")); err == nil {
		state.remaining = remaining
	}
	if reset, err := strconv.ParseFloat(resp.Header.Get("X-RateLimit-Reset"), 64); err == nil {
		state.resetAt = time.UnixMilli(int64(reset * 1000))
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		state.healthy = false
	}
}

// Upload streams a staged file to a Discord channel using multipart/form-data.
func (d *DiscordClient) Upload(bot Bot, stagedPath, originalName, mime string) (UploadResult, error) {
	var result UploadResult
	if lock := d.channelLock(bot.ChannelID); lock != nil {
		select {
		case lock <- struct{}{}:
			defer func() { <-lock }()
		case <-time.After(2 * time.Minute):
			return result, errors.New("timed out waiting for Discord channel")
		}
	}
	maxRetries := 3
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if err := d.acquire(bot); err != nil {
			return result, err
		}
		file, err := os.Open(stagedPath)
		if err != nil {
			return result, err
		}
		pr, pw := io.Pipe()
		mw := multipart.NewWriter(pw)
		go func() {
			defer file.Close()
			defer pw.Close()
			payload, _ := json.Marshal(map[string]any{
				"content":          "",
				"allowed_mentions": map[string]any{"parse": []string{}},
			})
			_ = mw.WriteField("payload_json", string(payload))
			part, err := mw.CreateFormFile("files[1]", sanitize(originalName))
			if err != nil {
				pw.CloseWithError(err)
				return
			}
			if mime == "" {
				mime = "application/octet-stream"
			}
			part.Header().Set("Content-Type", mime)
			if _, err := io.Copy(part, file); err != nil {
				pw.CloseWithError(err)
				return
			}
			_ = mw.Close()
		}()

		url := fmt.Sprintf("%s/channels/%s/messages?wait=true", d.apiBase, bot.ChannelID)
		req, err := http.NewRequest(http.MethodPost, url, pr)
		if err != nil {
			pr.Close()
			return result, err
		}
		req.Header.Set("Authorization", "Bot "+bot.Token)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("User-Agent", envOr("DISCORD_USER_AGENT", "DiscordBot (catbox-clone, 1.0)"))

		resp, err := d.client.Do(req)
		if err != nil {
			pr.Close()
			return result, err
		}
		d.observe(&bot, resp)

		if resp.StatusCode == http.StatusTooManyRequests {
			var payload struct {
				RetryAfter float64 `json:"retry_after"`
			}
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			_ = resp.Body.Close()
			_ = json.Unmarshal(body, &payload)
			wait := time.Duration(payload.RetryAfter*1000) * time.Millisecond
			if wait < 250*time.Millisecond {
				wait = 250 * time.Millisecond
			}
			d.mu.Lock()
			state := d.states[bot.ID]
			if resp.Header.Get("X-RateLimit-Global") == "true" {
				state.blockedUntil = time.Now().Add(wait)
			} else {
				state.remaining = 0
				state.blockedUntil = time.Now().Add(wait)
			}
			d.mu.Unlock()
			if attempt == maxRetries {
				return result, errors.New("Discord rate limit exceeded")
			}
			continue
		}

		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return result, fmt.Errorf("Discord upload failed (%d): %s", resp.StatusCode, string(body[:min(len(body), 300)]))
		}
		var message struct {
			ID          string `json:"id"`
			Attachments []struct {
				ID  string `json:"id"`
				URL string `json:"url"`
			} `json:"attachments"`
		}
		if err := json.Unmarshal(body, &message); err != nil {
			return result, err
		}
		if len(message.Attachments) == 0 {
			return result, errors.New("Discord response contained no attachment")
		}
		result.MessageID = message.ID
		result.AttachmentID = message.Attachments[0].ID
		result.URL = message.Attachments[0].URL
		result.ExpiresAt = expiryFromURL(result.URL)
		return result, nil
	}
	return result, errors.New("Discord upload failed")
}

// expiryFromURL reads the hex `ex` parameter Discord adds to attachment URLs.
func expiryFromURL(raw string) int64 {
	idx := strings.Index(raw, "ex=")
	if idx < 0 {
		return 0
	}
	part := raw[idx+3:]
	if end := strings.IndexAny(part, "&"); end >= 0 {
		part = part[:end]
	}
	seconds, err := strconv.ParseInt(part, 16, 64)
	if err != nil {
		return 0
	}
	return seconds * 1000
}

// Verify fetches the message to confirm the attachment is still present.
func (d *DiscordClient) Verify(bot Bot, channelID, messageID, attachmentID string) (string, error) {
	if err := d.acquire(bot); err != nil {
		return "", err
	}
	url := fmt.Sprintf("%s/channels/%s/messages?around=%s&limit=1", d.apiBase, channelID, messageID)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bot "+bot.Token)
	req.Header.Set("User-Agent", envOr("DISCORD_USER_AGENT", "DiscordBot (catbox-clone, 1.0)"))
	resp, err := d.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	d.observe(&bot, resp)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("Discord message fetch failed (%d)", resp.StatusCode)
	}
	var messages []struct {
		ID          string `json:"id"`
		Attachments []struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		} `json:"attachments"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&messages); err != nil {
		return "", err
	}
	for _, message := range messages {
		if message.ID != messageID {
			continue
		}
		for _, attachment := range message.Attachments {
			if attachment.ID == attachmentID {
				return attachment.URL, nil
			}
		}
	}
	return "", errors.New("Discord attachment is no longer available")
}
