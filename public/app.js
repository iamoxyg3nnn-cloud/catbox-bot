/* Hallmark · pre-emit critique: P5 H5 E4 S4 R4 V5 */
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const app = $('#app');

  // Upload ceiling mirrors the server's MAX_FILE_SIZE (default 20 MiB). The
  // server remains authoritative; this only gives the browser early feedback.
  let MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
  fetch('/api/config', { signal: AbortSignal.timeout(5000) })
    .then(response => response.ok ? response.json() : null)
    .then(cfg => { if (cfg && Number(cfg.maxFileSize) > 0) MAX_UPLOAD_BYTES = Number(cfg.maxFileSize); })
    .catch(() => {});
  const icons = {
    cat: '<path d="m4 8 1.3-4 3.2 2h3L14.7 4 16 8v5a6 6 0 0 1-12 0z"/><path d="M8 12h.01M12 12h.01M9 16h2"/>',
    upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M20 16v4H4v-4"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    grid: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 1 1 4.4 1.6c-1.1 1.1-2 1.4-2 3.4M12 17h.01"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11z"/><path d="m9 12 2 2 4-4"/>',
    spark: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    file: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7M8 15h8m-8 4h8"/>',
    external: '<path d="M14 3h7v7m0-7-10 10"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    trash: '<path d="M3 6h18m-2 0-.9 14H5.9L5 6m4 0V4h6v2m-5 4v6m4-6v6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    album: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 16l3-3 3 3 2-2 3 3"/><circle cx="9" cy="9" r="1"/>',
  };
  const icon = (name, small = false) => `<svg class="icon${small ? ' icon-sm' : ''}" aria-hidden="true" viewBox="0 0 24 24">${icons[name] || icons.file}</svg>`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const path = location.pathname;
  const isLitterbox = path === '/litterbox.php';
  const userPath = path.startsWith('/user/');
  const page = path === '/' || path === '/nofun.php' ? 'home'
    : path === '/litterbox.php' ? 'litterbox'
    : path === '/faq.php' ? 'faq'
    : path === '/tools.php' ? 'tools'
    : path === '/legal.php' ? 'legal'
    : path === '/contact.php' ? 'contact'
    : path === '/user/login.php' ? 'login'
    : path === '/user/register.php' ? 'register'
    : path === '/user/forgotpassword.php' ? 'forgot'
    : path === '/user/index.php' ? 'library'
    : path === '/user/albums.php' ? 'albums'
    : path.startsWith('/a/') ? 'album'
    : 'notfound';
  const header = () => `<header class="legacy-page-header"><a class="home-button" href="/">Home</a></header>`;
  const footer = () => `<footer class="legacy-footer"><a href="/faq.php">FAQ</a><a href="/legal.php">Terms & privacy</a><a href="/contact.php">Contact</a><button class="theme-toggle" data-theme-toggle type="button" aria-pressed="false">Go Dark?</button></footer>`;
  const shell = (active, content) => `<div class="classic-dashboard">${header()}<main id="main" class="legacy-content account-layout"><nav class="account-nav" aria-label="Account navigation"><span class="account-identity"><span class="account-avatar" data-avatar aria-hidden="true"></span><span>Signed in as <strong data-username></strong></span></span><a href="/user/index.php" ${active === 'library' ? 'aria-current="page"' : ''}>My files</a><a href="/user/albums.php" ${active === 'albums' ? 'aria-current="page"' : ''}>Albums</a><a href="/user/index.php#library-upload-panel" class="account-upload">Upload</a><button type="button" class="account-logout" data-logout>Sign out</button></nav><section class="legacy-user-panel">${content}</section></main>${footer()}</div>`;


  function homeMarkup(temporary = false) {
    const links = '<a href="/user/login.php">Login</a><a href="/user/register.php">Register</a><a href="/faq.php">FAQ</a><a href="/tools.php">Tools</a><a href="/legal.php">Legal / Privacy</a><a href="/contact.php">Contact</a><a href="/litterbox.php">Temporary uploads</a><button class="theme-toggle" data-theme-toggle type="button" aria-pressed="false">Go Dark?</button>';
    return `<div class="classic-home ${temporary ? 'is-temporary' : ''}"><main id="main" class="classic-main"><section class="classic-uploader" aria-label="Upload a file"><div class="upload-panel" id="panel-file"><label class="dropzone" id="dropzone" for="file-input"><input class="file-picker" id="file-input" type="file" aria-label="Select a file to upload"><span class="dropzone-title">Select or drop a file</span><span class="dropzone-hint">or tap to choose from your device · 20 MB max</span><span class="upload-file-name" id="file-name"></span></label></div><div class="urlUploads"><p><button class="classic-link" id="tab-url" type="button" aria-expanded="false" aria-controls="url-form">Upload via URL</button></p><form class="url-form" id="url-form" hidden><label class="field-label" for="file-url">Paste a direct file link</label><div class="url-input-row"><input class="field" id="file-url" name="url" type="url" placeholder="https://example.com/file.png" required><button class="classic-go" type="submit">Upload</button></div><button class="classic-link" id="tab-file-return" type="button" aria-expanded="false">Choose a file instead</button></form></div>${temporary ? '<div class="classic-expiry"><label for="expiry">Remove after</label><select id="expiry" class="select-small"><option value="1h">1 hour</option><option value="12h">12 hours</option><option value="24h" selected>24 hours</option><option value="72h">72 hours</option></select><small class="field-hint">The link works until this time, then the file is removed.</small></div>' : ''}<div class="upload-status" id="upload-status" role="status" aria-live="polite"></div><div class="progress-track" id="progress-track" hidden><span id="progress-bar"></span></div><div id="upload-result"></div></section><nav class="classic-nav" aria-label="Main navigation"><a href="/user/login.php">Sign in</a><a href="/user/register.php">Create account</a><a href="/faq.php">FAQ</a><a href="/tools.php">Tools</a><a href="/legal.php">Terms &amp; privacy</a><a href="/contact.php">Contact</a><a href="/litterbox.php">Temporary uploads</a><button class="theme-toggle" data-theme-toggle type="button" aria-pressed="false">Go Dark?</button></nav><details class="mobile-nav"><summary>Menu</summary><nav aria-label="Mobile navigation">${links.replace('>Login</a>', '>Sign in</a>').replace('>Register</a>', '>Create account</a>')}</nav></details><section class="classic-support"><p><strong>Simple file sharing, with clear limits.</strong></p><div class="classic-support-links"><a href="/faq.php">How uploads work</a><a href="/tools.php">Upload options</a><a href="/user/register.php">Create an account</a></div><div class="classic-support-bar"><span>Up to 20 MB · No account required</span></div></section><section class="classic-notice"><b>Need a temporary link?</b><br><a href="/litterbox.php">Use temporary uploads</a> to choose when the file expires.</section><p class="classic-privacy-note">${temporary ? 'Anyone with a temporary link can open the file until it expires.' : 'Anyone with a file link can open it. Sign in before uploading if you want to manage the file later.'}</p><footer class="legacy-footer"><a href="/contact.php">Contact</a></footer></main></div>`;
  }

  function initHomeLayout() {
    const home = $('.classic-home');
    const main = $('.classic-main', home);
    if (!home || !main) return;

    home.classList.add('catbox-home');

    const brandHero = document.createElement('header');
    brandHero.className = 'home-brand-hero';
    brandHero.innerHTML = `<h1 class="home-brand-title"><a class="home-brand-wordmark" href="/" aria-label="MewPocket home"><img class="home-brand-symbol" src="/assets/mewpocket.svg" width="64" height="64" alt=""><span>Mew<span class="home-brand-accent">Pocket</span></span></a></h1>`;
    main.prepend(brandHero);

    const topArtwork = document.createElement('img');
    topArtwork.className = 'legacy-artwork top-left-waifu home-artwork';
    topArtwork.src = '/assets/waifu/top-left/peeking-brunette.webp';
    topArtwork.alt = '';
    topArtwork.setAttribute('aria-hidden', 'true');
    const bottomArtwork = document.createElement('img');
    bottomArtwork.className = 'legacy-artwork bottom-right-waifu home-artwork';
    bottomArtwork.src = '/assets/waifu/bottom-right/smiling-blue-maid.webp';
    bottomArtwork.alt = '';
    bottomArtwork.setAttribute('aria-hidden', 'true');
    home.prepend(bottomArtwork, topArtwork);
    initArtworkRotation({ topLeft: topArtwork, bottomRight: bottomArtwork });
  }

  async function initArtworkRotation(corners) {
    let manifest;
    try {
      const response = await fetch('/assets/waifu/manifest.json', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Artwork manifest returned ${response.status}`);
      manifest = await response.json();
    } catch (error) {
      console.warn('Artwork rotation unavailable; keeping the default images.', error);
      return;
    }

    const groups = Object.entries(corners).map(([key, image]) => ({
      image,
      sources: [...new Set((Array.isArray(manifest?.[key]) ? manifest[key] : [])
        .map(entry => entry?.src)
        .filter(src => typeof src === 'string' && src.startsWith('/assets/waifu/')))],
      remaining: [],
    })).filter(group => group.sources.length > 1);
    if (!groups.length) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer;
    let active = true;
    let running = false;
    const visible = () => active && !document.hidden;
    const schedule = () => {
      clearTimeout(timer);
      if (visible()) timer = setTimeout(cycle, 10000);
    };

    async function rotate(group) {
      const { image, sources } = group;
      if (!group.remaining.length) {
        group.remaining = sources.filter(src => src !== image.getAttribute('src'));
      }
      while (group.remaining.length && visible() && image.isConnected) {
        const index = Math.floor(Math.random() * group.remaining.length);
        const [src] = group.remaining.splice(index, 1);
        const preload = new Image();
        preload.src = src;
        try { await preload.decode(); }
        catch { continue; }
        if (!visible() || !image.isConnected) return;
        if (!reducedMotion.matches) {
          image.classList.add('is-changing');
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (visible() && image.isConnected) image.src = src;
        image.classList.remove('is-changing');
        return;
      }
    }

    async function cycle() {
      if (!visible() || running) return;
      running = true;
      try { await Promise.all(groups.map(rotate)); }
      finally { running = false; schedule(); }
    }

    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('pagehide', () => { active = false; clearTimeout(timer); });
    window.addEventListener('pageshow', () => { active = true; schedule(); });
    cycle();
  }

  const pages = {
    faq: {
      title: 'Frequently asked questions', eyebrow: 'HELP & HOW-TO',
      intro: 'Clear answers about uploads, links, accounts, temporary files, and privacy.',
      body: `<section class="faq-section"><h2>Uploading</h2>
        <article class="faq-item"><h3>How do I upload a file?</h3><p>On the <a href="/">upload page</a>, select a file or drag one onto the upload area. You can also choose <strong>Upload via URL</strong> and paste a direct HTTP or HTTPS link. When the upload finishes, you’ll get a link you can copy and share.</p></article>
        <article class="faq-item"><h3>Do I need an account?</h3><p>No. You can upload without signing in. If you want files listed in a personal library and available for deletion, sign in before uploading. Files uploaded while signed out are not attached to an account.</p></article>
        <article class="faq-item"><h3>What is the file size limit?</h3><p>Each file can be up to 20 MB. The same limit applies to files fetched from a URL. Files over the limit are rejected before they are saved.</p></article>
        <article class="faq-item"><h3>Which file types are blocked?</h3><p>The service blocks <code>.exe</code>, <code>.scr</code>, <code>.doc</code>, and <code>.jar</code> files. If a file is refused, choose a permitted file type instead; changing a filename extension does not make unsafe content safe.</p></article>
        <article class="faq-item"><h3>Why did my URL upload fail?</h3><p>The link must use HTTP or HTTPS and point to a file the server can fetch without signing in. The source site may block automated requests, the link may have expired, or the file may exceed 20 MB or use a blocked type. Try a direct download link or select the file from your device.</p></article>
        <article class="faq-item"><h3>Does the service change my file?</h3><p>The service stores the uploaded bytes and serves the file with its recorded content type. It does not provide an editor, transcoder, virus scanner, or image optimizer.</p></article>
      </section><section class="faq-section"><h2>Links, storage, and privacy</h2>
        <article class="faq-item"><h3>Where are files actually stored?</h3><p>This is an experimental build. File bytes are sent to a Discord channel as a bot attachment and shared through signed CDN links. Local disk is used only briefly while a file is being transferred, then removed. Do not use this service for confidential or irreplaceable files.</p></article>
        <article class="faq-item"><h3>Who can open a file link?</h3><p>Anyone who has the direct link can request the file. Links are not password protected, and this app does not provide a public search page. Treat a link as public once you share it, and do not use this service for confidential files.</p></article>
        <article class="faq-item"><h3>How long do regular uploads stay online?</h3><p>Regular uploads have no automatic expiry in this version. A signed-in owner can remove their own files from the library. Signed-out uploads are not attached to an owner and cannot currently be removed through the website, so use temporary uploads when you need automatic cleanup.</p></article>
        <article class="faq-item"><h3>How do temporary uploads work?</h3><p>Open <a href="/litterbox.php">Temporary uploads</a>, choose an expiry of 1, 12, 24, or 72 hours, then upload a file or a direct URL. The service removes the file after its expiry time. Expiry is a cleanup setting, not a privacy control while the link is active.</p></article>
        <article class="faq-item"><h3>Can I delete a file?</h3><p>Sign in before uploading. In <a href="/user/index.php">My files</a>, use the delete control beside a file you own. Deleting the file also makes its existing link stop working. Signed-out uploads cannot be deleted from the current interface.</p></article>
      </section><section class="faq-section"><h2>Accounts and albums</h2>
        <article class="faq-item"><h3>What do I need to create an account?</h3><p>Choose a username with 3–25 letters, numbers, or underscores, enter a valid email address, and use a password of at least 8 characters. Sign in before uploading so files are associated with your library.</p></article>
        <article class="faq-item"><h3>I forgot my password. Can I reset it?</h3><p>Self-service password reset is not configured in this build. Use the <a href="/contact.php">contact form</a> to ask the site operator for help. The form records a message locally; it does not send email automatically.</p></article>
        <article class="faq-item"><h3>What is an album?</h3><p>An album groups files from your account into one shareable page. Open <a href="/user/albums.php">Albums</a>, create an album, add a title, optionally add a description, then select one or more files. Anyone with the album link can view its contents.</p></article>
      </section>`
    },
    tools: {
      title: 'Upload and sharing tools', eyebrow: 'WHAT YOU CAN DO',
      intro: 'Pick the upload method that fits, then share the link you receive.',
      body: `<section class="tool-section"><h2>Upload from your device</h2><ol><li>Open the <a href="/">upload page</a>.</li><li>Tap the upload area or drag a file onto it.</li><li>Wait for the completion message, then copy the generated link.</li></ol><p>One file per upload, up to 20 MB. Files ending in <code>.exe</code>, <code>.scr</code>, <code>.doc</code>, or <code>.jar</code> are blocked.</p></section>
        <section class="tool-section"><h2>Upload from a URL</h2><ol><li>Choose <strong>Upload via URL</strong>.</li><li>Paste a direct HTTP or HTTPS link to a file.</li><li>Choose <strong>Upload</strong> and wait while the server fetches it.</li></ol><p>The source must allow the server to fetch the file without a login. URL uploads share the same 20 MB and blocked-file limits.</p></section>
        <section class="tool-section"><h2>Create a temporary link</h2><p>Use <a href="/litterbox.php">Temporary uploads</a> to choose automatic removal after 1, 12, 24, or 72 hours. The link works until the expiry; anyone who has it can access the file during that time.</p></section>
        <section class="tool-section"><h2>Keep files in a library</h2><p>Create an account and sign in before uploading. Your files appear in <a href="/user/index.php">My files</a>, where you can search, open, copy, and delete files you own. Use <a href="/user/albums.php">Albums</a> to gather selected files on one public page.</p><p>Signed-out uploads are not attached to your library and cannot currently be deleted through the website.</p></section>
        <section class="tool-section"><h2>Understand the limits</h2><p>This is a simple link-based file host. It does not add passwords to links, scan files for malware, edit media, or guarantee long-term availability. Do not use it for confidential material or as your only backup.</p><p>For details, read the <a href="/faq.php">FAQ</a> and <a href="/legal.php">Terms and privacy notes</a>.</p></section>`
    },
    legal: {
      title: 'Terms and privacy', eyebrow: 'SERVICE INFORMATION',
      intro: 'What this version stores, how sharing works, and what to consider before uploading.',
      body: `<p class="policy-note"><strong>About this page.</strong> This page describes the current service behavior. The site operator should review and adapt it for their jurisdiction, hosting setup, and actual retention practices before offering the service publicly.</p>
        <p class="policy-note"><strong>Experimental storage.</strong> File bytes are stored as Discord message attachments and delivered through signed CDN links. Local disk is transient staging only. Availability depends on Discord, and this service is not a backup or a private vault.</p>
        <section class="policy-section"><h2>Using the service</h2><p>Only upload files you have the right to store and share. Do not use this service to distribute unlawful material, malware, files that violate another person’s rights, or content intended to harm others. The operator may disable access to the service or remove material where required to protect users, rights holders, or the service.</p><p>You are responsible for the files you upload and for choosing who receives their links. A successful upload does not establish that you have permission to distribute the file.</p></section>
        <section class="policy-section"><h2>Links and public access</h2><p>A direct file link is a bearer link: anyone who obtains it can open the file. Links have no password or viewer-specific access control. The service does not provide a public file-search page, but that is not a confidentiality guarantee. Do not upload confidential, sensitive, or irreplaceable material.</p><p>Album pages are also available to anyone with the album URL. Adding a file to an album makes it part of that page until you change or remove it.</p></section>
        <section class="policy-section"><h2>Storage, expiry, and deletion</h2><p>Regular uploads do not have an automatic expiry in this version. Signed-in users can delete files attached to their account from My files. A file uploaded while signed out is not attached to an owner and cannot currently be deleted through the website.</p><p>Temporary uploads are removed after the selected 1, 12, 24, or 72 hour period. The link remains accessible while the file is present. Temporary expiry is not an access restriction.</p><p>The operator controls the server and its backups. Removing an item from the live service does not describe how long copies may remain in external backups or infrastructure managed by the operator.</p></section>
        <section class="policy-section"><h2>Information stored by the application</h2><ul><li><strong>Accounts:</strong> username, email address, password hash, account identifier, and account creation time.</li><li><strong>Sessions:</strong> a session token and expiry. The app uses a session cookie and a separate account identifier cookie to associate uploads with a signed-in account.</li><li><strong>Files:</strong> stored file bytes, original filename, content type, size, upload time, optional account owner, and optional expiry.</li><li><strong>Albums:</strong> title, description, owner, creation time, and the files included in the album.</li><li><strong>Contact messages:</strong> name, optional email address, message text, and submission time. Messages are recorded in the application database; this build does not send them by email.</li></ul><p>When you submit a URL, the server requests that address and stores the returned file. The remote site and the server operator may process ordinary connection metadata as part of that request.</p></section>
        <section class="policy-section"><h2>Cookies and security</h2><p>The app uses cookies to keep signed-in sessions working and to associate uploads with an account. Passwords are stored as password hashes rather than readable passwords. This does not make shared file links private or guarantee that the service is secure against every threat.</p><p>Files are served to anyone with their link. This is not a malware scanner, private vault, backup guarantee, or encrypted end-to-end file transfer system. Use a service designed for your security needs when those protections are required.</p></section>
        <section class="policy-section"><h2>File limits and availability</h2><p>Uploads are limited to 20 MB per file. The application blocks <code>.exe</code>, <code>.scr</code>, <code>.doc</code>, and <code>.jar</code> files. The service may be unavailable, links may stop working, and files may be removed or become unavailable. Keep a separate copy of important files.</p></section>
        <section class="policy-section"><h2>Contact and requests</h2><p>Use the <a href="/contact.php">contact form</a> to send a question or report a file. Messages are recorded locally for the site operator; email is optional and no automatic email reply is sent. Include the relevant file link when reporting an issue, but do not include passwords or private credentials.</p></section>`
    },
    contact: {
      title: 'Contact the site operator', eyebrow: 'QUESTIONS & REPORTS',
      intro: 'Ask for help, report a broken link, or flag a file. Include enough detail to identify the issue.',
      body: `<div class="contact-notice"><h2>Before you send</h2><p>This form stores your message in the site database for the operator to review. It does not send an email automatically. Add an email address only if you want the operator to be able to reply. Never include your password or other login credentials.</p><p>For a file report, include the file or album URL and explain the issue. Do not attach private files to the message.</p></div><form class="contact-form" id="contact-form"><div class="field-group"><label class="field-label" for="contact-name">Your name</label><input class="field" id="contact-name" name="sendername" autocomplete="name" maxlength="100" required></div><div class="field-group"><label class="field-label" for="contact-email">Reply email <span class="muted">(optional)</span></label><input class="field" id="contact-email" name="email" type="email" autocomplete="email" maxlength="200" aria-describedby="contact-email-hint"><small class="field-hint" id="contact-email-hint">Only include this if you want a reply.</small></div><div class="field-group"><label class="field-label" for="contact-message">Message</label><textarea class="field field-textarea" id="contact-message" name="message" maxlength="5000" aria-describedby="contact-message-hint" required></textarea><small class="field-hint" id="contact-message-hint">Do not include passwords, payment details, or private files.</small></div><div id="contact-status" class="upload-status" role="status" aria-live="polite"></div><button class="button button-dark" type="submit">Save message ${icon('send', true)}</button></form>`
    },
  };



  function renderStaticPage(data) {
    return `<div class="legacy-page">${header()}<main id="main" class="legacy-content"><section class="content-heading"><span class="eyebrow">${data.eyebrow}</span><h1 class="legacy-page-title">${data.title}</h1><p class="legacy-page-subtitle">${data.intro}</p></section><section class="page-content">${data.body}</section></main>${footer()}</div>`;
  }

  function authMarkup(mode) {
    if (mode === 'forgot') return `<div class="legacy-page">${header()}<main id="main" class="legacy-content auth-layout auth-layout-reset"><section class="auth-copy"><span class="eyebrow">ACCOUNT HELP</span><h1 class="legacy-page-title">Can’t sign in?</h1><p class="legacy-page-subtitle">Password reset is not available in this version.</p></section><section class="classic-form-panel reset-help"><p>For account safety, this site does not change passwords or email reset links from this page.</p><p>Use the <a href="/contact.php">contact form</a> to ask the site operator for help. Messages are saved for review and are not emailed automatically.</p><a class="classic-submit reset-contact" href="/contact.php">Contact the site operator</a><a class="auth-switch" href="/user/login.php">Back to sign in</a></section></main>${footer()}</div>`;
    const isRegister = mode === 'register';
    const data = isRegister
      ? {
        title: 'One home for<br><span class="auth-title-accent">the files you share.</span>',
        intro: 'Create an account to keep uploads organized and gather selected files into shareable albums.',
        formTitle: 'Create your account',
        formIntro: 'A few details and your library is ready.',
        fields: `<label for="username">Username</label><input class="field" id="username" name="username" autocomplete="username" minlength="3" maxlength="25" pattern="[A-Za-z0-9_]{3,25}" aria-describedby="username-hint" required><small class="field-hint" id="username-hint">3–25 letters, numbers, or underscores.</small><label for="email">Email address</label><input class="field" id="email" name="email" type="email" autocomplete="email" maxlength="254" required><label for="password">Password</label><input class="field" id="password" name="password" type="password" autocomplete="new-password" minlength="8" aria-describedby="password-hint" required><small class="field-hint" id="password-hint">At least 8 characters.</small>`,
        submit: 'Create account',
        footer: `<span class="auth-switch-copy">Already have an account? <a href="/user/login.php">Sign in</a></span>`,
      }
      : {
        title: 'Your files,<br><span class="auth-title-accent">all in one place.</span>',
        intro: 'Sign in to find your uploads, keep links tidy, and manage your albums.',
        formTitle: 'Welcome back',
        formIntro: 'Sign in to continue to your library.',
        fields: `<label for="username">Username</label><input class="field" id="username" name="username" autocomplete="username" required><label for="password">Password</label><input class="field" id="password" name="password" type="password" autocomplete="current-password" required>`,
        submit: 'Sign in',
        footer: `<span class="auth-switch-copy">Need an account? <a href="/user/register.php">Create one</a></span><a class="auth-recovery" href="/user/forgotpassword.php">Can’t sign in?</a>`,
      };
    const benefits = [
      ['folder', 'Keep uploads together', 'Find and manage files you add while signed in.'],
      ['album', 'Share a whole collection', 'Group selected files into one album link.'],
      ['shield', 'Stay in control', 'Search, copy, or remove your own uploads.'],
    ].map(([symbol, title, description]) => `<li><span class="auth-benefit-icon">${icon(symbol, true)}</span><span><strong>${title}</strong><small>${description}</small></span></li>`).join('');
    return `<div class="legacy-page">${header()}<main id="main" class="legacy-content auth-layout"><section class="auth-copy"><span class="eyebrow">${isRegister ? 'A LITTLE MORE ORGANIZED' : 'WELCOME BACK'}</span><h1 class="legacy-page-title">${data.title}</h1><p class="legacy-page-subtitle">${data.intro}</p><ul class="auth-benefits">${benefits}</ul><p class="auth-privacy-note">${icon('lock', true)} Shared files are available to anyone with their link.</p></section><form class="auth-card classic-form-panel" id="auth-form" data-mode="${mode}"><div class="auth-form-heading"><span class="auth-form-icon">${icon(isRegister ? 'spark' : 'cat', true)}</span><span><strong>${data.formTitle}</strong><small>${data.formIntro}</small></span></div><div class="auth-fields">${data.fields}</div><div class="auth-error" id="auth-error" role="alert" aria-live="polite"></div><button class="classic-submit" type="submit">${data.submit} ${icon('arrow', true)}</button><p class="auth-switch">${data.footer}</p></form></main>${footer()}</div>`;
  }

  function renderLibrary() {
    const content = `<section class="page-intro"><div><span class="eyebrow">YOUR ACCOUNT</span><h1>My files</h1><p>Files uploaded while you were signed in. Signed-out uploads do not appear here.</p></div><button class="button button-primary" type="button" data-open-library-upload aria-expanded="false" aria-controls="library-upload-panel">${icon('upload', true)} Upload a file</button></section><section class="library-upload-panel" id="library-upload-panel" aria-labelledby="library-upload-title" hidden><div class="library-upload-heading"><div><span class="eyebrow">ADD TO YOUR LIBRARY</span><h2 id="library-upload-title">Upload a file</h2><p>Files uploaded here are saved to your account. Up to 20 MB per file.</p></div><button class="button button-quiet button-small" id="library-upload-close" type="button">Close</button></div><label class="library-upload-dropzone" id="library-upload-dropzone" for="library-file-input"><input class="library-upload-input" id="library-file-input" type="file" aria-describedby="library-upload-hint"><span class="library-upload-prompt">${icon('upload', true)} Choose a file or drop it here</span><span class="field-hint" id="library-upload-hint">The file will be added to your account library.</span><span class="library-upload-filename" id="library-upload-filename"></span></label><div class="upload-status" id="library-upload-status" role="status" aria-live="polite"></div><div class="progress-track" id="library-upload-progress" role="progressbar" aria-label="Upload progress" aria-valuemin="0" aria-valuemax="100" hidden><span id="library-upload-progress-bar"></span></div><div id="library-upload-result"></div></section><section class="metric-row" id="metrics"><div class="metric-card"><div class="metric-label">Files</div><div class="metric-value" id="file-count">—</div><div class="metric-foot">Available in your library</div></div><div class="metric-card"><div class="metric-label">Albums</div><div class="metric-value" id="album-count">—</div><div class="metric-foot"><a href="/user/albums.php">View albums</a></div></div><div class="metric-card"><div class="metric-label">Sharing reminder</div><div class="metric-value metric-note">${icon('shield', true)} Link access</div><div class="metric-foot">Anyone with a link can open that file</div></div></section><section class="library-card"><div class="library-head"><div><h2>Your uploads</h2><p>Search, open, copy, or remove a file you own.</p></div><label class="search-label" for="file-search">Find a file<input class="search-box" id="file-search" type="search" placeholder="Search filenames" autocomplete="off"></label></div><div class="table-labels" id="file-table-head" hidden><span>File</span><span>Size</span><span>Added</span><span class="actions-label">Actions</span></div><div class="file-list" id="file-list" aria-live="polite"><div class="loading-state" role="status">Loading your files…</div></div><p class="search-empty" id="file-search-empty" hidden>No files match that search. Try another filename.</p></section>`;
    return shell('library', content);
  }

  function renderAlbums() {
    const content = `<section class="page-intro"><div><span class="eyebrow">YOUR ACCOUNT</span><h1>Albums</h1><p>Group files you own into one shareable page. Anyone with its link can view it.</p></div><a class="button button-quiet" href="/user/index.php">My files</a></section><section class="library-card"><div class="library-head"><div><h2>Your albums</h2><p>Each album has a title, an optional note, and selected files.</p></div><button class="button button-dark button-small" id="new-album" aria-expanded="false" aria-controls="album-form-wrap">${icon('album', true)} New album</button></div><div class="album-grid" id="album-grid" aria-live="polite"><div class="loading-state" role="status">Loading your albums…</div></div></section><section class="library-card album-form-card" id="album-form-wrap" hidden><div class="library-head"><div><h2 id="album-form-title">Create an album</h2><p>Give it a title, then select at least one file from your library.</p></div></div><form class="album-form" id="album-form"><div class="field-group"><label class="field-label" for="album-title">Album title</label><input class="field" id="album-title" name="title" maxlength="200" required></div><div class="field-group"><label class="field-label" for="album-desc">Description <span class="muted">(optional)</span></label><textarea class="field field-textarea" id="album-desc" name="desc" maxlength="2000" rows="3"></textarea><small class="field-hint">Up to 2,000 characters.</small></div><fieldset id="album-files" class="album-file-picker" tabindex="-1" aria-describedby="album-error"><legend class="field-label">Choose files</legend><div class="loading-state" role="status">Loading your files…</div></fieldset><div id="album-error" class="auth-error" role="alert" aria-live="polite"></div><div class="album-form-actions"><button class="button button-dark" type="submit">Create album ${icon('arrow', true)}</button><button class="button button-quiet" id="cancel-album" type="button">Cancel</button></div></form></section>`;
    return shell('albums', content, 'Albums');
  }

  function fileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  function signOut(button) {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const response = await fetch('/user/logout.php', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Sign out failed. Please try again.');
        location.assign('/user/login.php');
      } catch {
        button.disabled = false;
        toast('Could not sign out. Check your connection and try again.', 'error');
      }
    };
  }
  function dateShort(value) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(Number(value))); }
  function fileKind(file) { return file.mime?.startsWith('image/') ? 'image' : 'file'; }
  async function getDashboard() {
    const response = await fetch('/api/dashboard');
    if (response.status === 401) { location.assign('/user/login.php'); throw new Error('Please sign in.'); }
    if (!response.ok) throw new Error('Could not load your files. Please try again.');
    return response.json();
  }
  function fileRow(file) {
    const originalName = file.originalName || file.name;
    return `<article class="file-row" data-file-name="${esc(originalName.toLowerCase())}"><div class="file-main"><span class="file-type">${icon(fileKind(file))}</span><div class="file-labels"><div class="file-name" title="${esc(originalName)}">${esc(originalName)}</div><div class="file-sub">${esc(file.name)}</div></div></div><span class="file-size">${fileSize(file.size)}</span><span class="file-date">${dateShort(file.uploadedAt)}</span><div class="row-actions"><button class="icon-button" type="button" data-copy="${esc(file.url)}" aria-label="Copy link for ${esc(originalName)}">${icon('copy', true)}</button><a class="icon-button" href="${esc(file.url)}" target="_blank" rel="noopener" aria-label="Open ${esc(originalName)}">${icon('external', true)}</a><button class="icon-button" type="button" data-delete="${esc(file.name)}" aria-label="Delete ${esc(originalName)}">${icon('trash', true)}</button></div></article>`;
  }
  function renderFileList(files) {
    const target = $('#file-list');
    $('#file-table-head').hidden = !files.length;
    if (!files.length) {
      target.innerHTML = `<div class="empty-state"><span class="upload-glyph">${icon('folder')}</span><h3>Your library is ready when you are.</h3><p>Uploads you make while signed in will appear here. Keep this little space for the files you want to find again.</p><button class="button button-quiet button-small" type="button" data-open-library-upload aria-expanded="false" aria-controls="library-upload-panel">Upload your first file ${icon('arrow', true)}</button></div>`;
    } else target.innerHTML = files.map(fileRow).join('');
  }
  async function initLibrary() {
    signOut($('[data-logout]'));
    try {
      const data = await getDashboard();
      $('[data-username]').textContent = data.user.username;
      $('[data-avatar]').textContent = data.user.username.slice(0, 1).toUpperCase();
      $('#file-count').textContent = data.files.length;
      $('#album-count').textContent = data.albums.length;
      renderFileList(data.files);
      const applySearch = () => {
        const query = $('#file-search').value.trim().toLowerCase();
        let visible = 0;
        $$('.file-row').forEach(row => { row.hidden = !row.dataset.fileName.includes(query); if (!row.hidden) visible++; });
        $('#file-search-empty').hidden = !data.files.length || !query || visible > 0;
      };
      $('#file-search').oninput = applySearch;
      initLibraryUpload(data, applySearch);
      $('#file-list').onclick = async event => {
        const copy = event.target.closest('[data-copy]');
        const remove = event.target.closest('[data-delete]');
        if (copy) await copyText(copy.dataset.copy);
        if (remove) {
          const file = data.files.find(item => item.name === remove.dataset.delete);
          const name = file?.originalName || file?.name || 'this file';
          if (!window.confirm(`Delete “${name}”? Its link will stop working.`)) return;
          remove.disabled = true;
          try {
            const body = new FormData(); body.append('reqtype', 'deletefiles'); body.append('userhash', getCookie('userhash')); body.append('files', remove.dataset.delete);
            const result = await fetch('/user/api.php', { method: 'POST', body });
            const message = await result.text();
            if (!result.ok) { toast(message || 'The file could not be deleted. Try again.', 'error'); return; }
            data.files = data.files.filter(item => item.name !== remove.dataset.delete);
            $('#file-count').textContent = data.files.length;
            renderFileList(data.files); applySearch();
            toast('File deleted. Its link no longer works.');
          } catch { toast('Could not reach the server. The file was not deleted.', 'error'); }
          finally { if (remove.isConnected) remove.disabled = false; }
        }
      };
    } catch (error) { if (error.message !== 'Please sign in.') $('#file-list').innerHTML = `<div class="empty-state"><h3>We couldn’t load your files.</h3><p>${esc(error.message)} Your files have not been changed.</p><button class="button button-quiet" type="button" data-retry>Try again</button></div>`; $('#file-list [data-retry]')?.addEventListener('click', () => location.reload()); }
  }
  function initLibraryUpload(data, applySearch) {
    const panel = $('#library-upload-panel');
    const input = $('#library-file-input');
    const dropzone = $('#library-upload-dropzone');
    const status = $('#library-upload-status');
    const progress = $('#library-upload-progress');
    const progressBar = $('#library-upload-progress-bar');
    const filename = $('#library-upload-filename');
    const result = $('#library-upload-result');
    const triggers = () => $$('[data-open-library-upload]');
    const setExpanded = expanded => triggers().forEach(button => button.setAttribute('aria-expanded', String(expanded)));
    let request = null;

    function openPanel(openPicker = true) {
      panel.hidden = false;
      setExpanded(true);
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (openPicker) input.click();
    }

    $('.legacy-user-panel').addEventListener('click', event => {
      const trigger = event.target.closest('[data-open-library-upload]');
      if (!trigger || request) return;
      openPanel();
    });
    if (location.hash === '#library-upload-panel') openPanel(false);
    $('#library-upload-close').addEventListener('click', () => {
      if (request) return;
      panel.hidden = true;
      setExpanded(false);
      triggers()[0]?.focus();
    });

    function upload(file) {
      if (!file || request) return;
      if (file.size > MAX_UPLOAD_BYTES) {
        filename.textContent = '';
        status.textContent = 'This file is larger than the 20 MB limit. Choose a smaller file.';
        status.dataset.kind = 'error';
        input.value = '';
        return;
      }

      filename.textContent = file.name;
      status.textContent = 'Preparing your upload…';
      status.dataset.kind = '';
      result.replaceChildren();
      progress.hidden = false;
      progress.setAttribute('aria-valuenow', '0');
      progressBar.style.width = '0%';
      input.disabled = true;
      $('#library-upload-close').disabled = true;
      triggers().forEach(button => { button.disabled = true; });
      dropzone.setAttribute('aria-busy', 'true');

      const body = new FormData();
      body.append('reqtype', 'fileupload');
      body.append('fileToUpload', file);
      const userhash = getCookie('userhash');
      if (userhash) body.append('userhash', userhash);
      request = new XMLHttpRequest();
      request.open('POST', '/user/api.php');
      request.setRequestHeader('X-Catbox-Async', '1');
      request.upload.onprogress = event => {
        if (!event.lengthComputable) return;
        const percent = Math.round(event.loaded / event.total * 100);
        progressBar.style.width = `${percent}%`;
        progress.setAttribute('aria-valuenow', String(percent));
        status.textContent = `Uploading · ${percent}%`;
      };
      request.onload = async () => {
        progress.hidden = true;
        if (request.status === 202) {
          try {
            const job = JSON.parse(request.responseText);
            status.textContent = 'Queued for upload…';
            const url = await pollJob(job.status_url, state => {
              status.textContent = state === 'uploading' ? 'Uploading to storage…' : 'Queued for upload…';
            });
            const name = new URL(url, location.origin).pathname.split('/').pop();
            data.files.unshift({ name, originalName: file.name, mime: file.type || 'application/octet-stream', size: file.size, uploadedAt: Date.now(), url });
            $('#file-count').textContent = data.files.length;
            renderFileList(data.files);
            applySearch();
            status.textContent = 'Upload complete. Your file is now in My files.';
            status.dataset.kind = 'success';
            result.innerHTML = `<div class="result-link"><a href="${esc(url)}" target="_blank" rel="noopener">Open uploaded file</a><button class="classic-copy" type="button" data-upload-copy>Copy link</button></div>`;
            $('[data-upload-copy]', result).addEventListener('click', () => copyText(url));
          } catch (error) {
            status.textContent = error.message || 'The upload could not be completed.';
            status.dataset.kind = 'error';
          } finally {
            finish();
          }
          return;
        }
        if (request.status < 200 || request.status >= 300) {
          status.textContent = request.responseText || 'That upload didn’t work. Please try again.';
          status.dataset.kind = 'error';
          finish();
          return;
        }

        const url = request.responseText.trim();
        const name = new URL(url, location.origin).pathname.split('/').pop();
        data.files.unshift({ name, originalName: file.name, mime: file.type || 'application/octet-stream', size: file.size, uploadedAt: Date.now(), url });
        $('#file-count').textContent = data.files.length;
        renderFileList(data.files);
        applySearch();
        status.textContent = 'Upload complete. Your file is now in My files.';
        status.dataset.kind = 'success';
        result.innerHTML = `<div class="result-link"><a href="${esc(url)}" target="_blank" rel="noopener">Open uploaded file</a><button class="classic-copy" type="button" data-upload-copy>Copy link</button></div>`;
        $('[data-upload-copy]', result).addEventListener('click', () => copyText(url));
        finish();
      };
      request.onerror = () => {
        progress.hidden = true;
        status.textContent = 'Could not reach the server. Please try again.';
        status.dataset.kind = 'error';
        finish();
      };
      request.onabort = () => {
        progress.hidden = true;
        status.textContent = 'Upload cancelled.';
        status.dataset.kind = 'error';
        finish();
      };
      input.value = '';
      try { request.send(body); }
      catch {
        progress.hidden = true;
        status.textContent = 'Could not start the upload. Please try again.';
        status.dataset.kind = 'error';
        finish();
      }

      function finish() {
        request = null;
        input.disabled = false;
        $('#library-upload-close').disabled = false;
        triggers().forEach(button => { button.disabled = false; });
        dropzone.removeAttribute('aria-busy');
      }
    }

    input.addEventListener('change', () => upload(input.files?.[0]));
    ['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, event => {
      event.preventDefault();
      dropzone.classList.add('is-dragging');
    }));
    ['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, event => {
      event.preventDefault();
      dropzone.classList.remove('is-dragging');
    }));
    dropzone.addEventListener('drop', event => upload(event.dataTransfer.files?.[0]));
  }
  async function initAlbums() {
    signOut($('[data-logout]'));
    try {
      const data = await getDashboard();
      $('[data-username]').textContent = data.user.username;
      $('[data-avatar]').textContent = data.user.username.slice(0, 1).toUpperCase();
      const grid = $('#album-grid');
      const showAlbums = () => grid.innerHTML = data.albums.length ? data.albums.map(album => `<article class="album-card"><span class="album-icon">${icon('album')}</span><h3>${esc(album.title)}</h3><p>${esc(album.description || 'A collection of your files.')}</p><div class="album-url"><a href="/a/${esc(album.short)}">/a/${esc(album.short)}</a><button class="icon-button" data-copy="${esc(location.origin)}/a/${esc(album.short)}" aria-label="Copy album link">${icon('copy', true)}</button></div></article>`).join('') : `<div class="empty-state" style="grid-column:1/-1"><span class="upload-glyph">${icon('album')}</span><h3>No albums yet.</h3><p>Pick a few files from your library and turn them into one tidy link.</p></div>`;
      showAlbums();
      grid.onclick = event => { const button = event.target.closest('[data-copy]'); if (button) copyText(button.dataset.copy); };
      const newAlbumButton = $('#new-album');
      newAlbumButton.onclick = () => {
        const wrap = $('#album-form-wrap'); wrap.hidden = false; newAlbumButton.setAttribute('aria-expanded', 'true'); wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#album-title').focus();
        const fieldset = $('#album-files');
        if (fieldset.dataset.loaded) return;
        fieldset.dataset.loaded = 'true';
        fieldset.innerHTML = data.files.length ? data.files.map(file => `<label class="album-file-option"><input type="checkbox" name="files" value="${esc(file.name)}"><span>${esc(file.originalName || file.name)} <small>${fileSize(file.size)}</small></span></label>`).join('') : '<p class="option-note">You do not have any files to add yet. Upload a file while signed in, then return here.</p>';
      };
      $('#cancel-album').onclick = () => { $('#album-form').reset(); $('#album-error').textContent = ''; $('#album-form-wrap').hidden = true; newAlbumButton.setAttribute('aria-expanded', 'false'); newAlbumButton.focus(); };
      $('#album-form').onsubmit = async event => {
        event.preventDefault(); const form = event.currentTarget;
        if (!form.reportValidity() || form.dataset.submitting === 'true') return;
        const selected = [...form.querySelectorAll('[name="files"]:checked')].map(input => input.value);
        if (!selected.length) { $('#album-error').textContent = 'Choose at least one file for your album.'; $('#album-files').focus(); return; }
        const body = new FormData(); body.append('reqtype', 'createalbum'); body.append('userhash', getCookie('userhash')); body.append('title', $('#album-title').value.trim()); body.append('desc', $('#album-desc').value.trim()); body.append('files', selected.join(' '));
        const button = form.querySelector('button[type="submit"]'); form.dataset.submitting = 'true'; button.disabled = true; button.textContent = 'Creating album…'; $('#album-error').textContent = '';
        try {
          const response = await fetch('/user/api.php', { method: 'POST', body }); const result = await response.text();
          if (!response.ok) { $('#album-error').textContent = result || 'The album could not be created. Check your details and try again.'; form.dataset.submitting = 'false'; button.disabled = false; button.innerHTML = `Create album ${icon('arrow', true)}`; return; }
          location.assign(result);
        } catch { $('#album-error').textContent = 'Could not reach the server. Your album was not created. Try again.'; form.dataset.submitting = 'false'; button.disabled = false; button.innerHTML = `Create album ${icon('arrow', true)}`; }
      };
    } catch (error) { if (error.message !== 'Please sign in.') $('#album-grid').innerHTML = `<div class="empty-state"><h3>We couldn’t load your albums.</h3><p>${esc(error.message)} Your albums have not been changed.</p><button class="button button-quiet" type="button" data-retry>Try again</button></div>`; $('#album-grid [data-retry]')?.addEventListener('click', () => location.reload()); }
  }
  function getCookie(name) { return document.cookie.split('; ').find(cookie => cookie.startsWith(`${name}=`))?.split('=').slice(1).join('=') || ''; }

  // Follow a 202 job response until the background Discord upload finishes.
  async function pollJob(statusUrl, onUpdate) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 700));
      const response = await fetch(statusUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not check the upload status. Please try again.');
      const job = await response.json();
      if (job.status === 'ready') return job.url;
      if (job.status === 'failed') throw new Error(job.error || 'The upload could not be completed.');
      onUpdate?.(job.status);
    }
    throw new Error('This upload is taking longer than expected. Try refreshing the page in a moment.');
  }
  async function copyText(text) {
    try {
      try { await navigator.clipboard.writeText(text); }
      catch {
        const field = document.createElement('textarea'); field.value = text; field.setAttribute('readonly', '');
        field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select();
        const copied = document.execCommand('copy'); field.remove();
        if (!copied) throw new Error('Clipboard unavailable');
      }
      toast('Link copied. Ready to share.');
    } catch { toast('Couldn’t copy automatically. Select the link and copy it manually.', 'error'); }
  }
  let toastTimer;
  function toast(message, kind = 'success') {
    $('.toast')?.remove(); clearTimeout(toastTimer);
    const node = document.createElement('div'); node.className = 'toast'; node.dataset.kind = kind; node.setAttribute('role', kind === 'error' ? 'alert' : 'status'); node.textContent = message; document.body.append(node);
    toastTimer = setTimeout(() => node.remove(), 3400);
  }

  function initUpload() {
    const input = $('#file-input');
    if (!input) return;
    const filePanel = $('#panel-file'); const urlPanel = $('#url-form'); const urlTab = $('#tab-url'); const fileReturn = $('#tab-file-return');
    const status = $('#upload-status'); const result = $('#upload-result'); const progress = $('#progress-track'); const bar = $('#progress-bar'); const fileName = $('#file-name');
    const fileTab = $('#tab-file');
    const dropzone = $('#dropzone');
    let uploadBusy = false;
    let request = null;
    function showFilePanel() {
      filePanel.hidden = false; urlPanel.hidden = true; fileReturn?.setAttribute('aria-expanded', 'false');
      fileTab?.setAttribute('aria-selected', 'true'); urlTab?.setAttribute('aria-selected', 'false'); urlTab?.setAttribute('aria-expanded', 'false');
    }
    function showUrlPanel() {
      filePanel.hidden = true; urlPanel.hidden = false; fileTab?.setAttribute('aria-selected', 'false'); urlTab?.setAttribute('aria-selected', 'true');
      urlTab?.setAttribute('aria-expanded', 'true');
      $('#file-url')?.focus();
    }
    urlTab?.addEventListener('click', showUrlPanel);
    fileReturn?.addEventListener('click', showFilePanel);
    function setStatus(message, kind = '') { if (!status) return; status.textContent = message; status.dataset.kind = kind; }
    function showLink(url) {
      result.innerHTML = `<div class="result-link"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a><button class="classic-copy" type="button" data-result-copy>Copy link</button></div>`;
      $('[data-result-copy]', result)?.addEventListener('click', () => copyText(url));
    }
    function upload(file) {
      if (!file) return;
      if (uploadBusy) { input.value = ''; setStatus('An upload is already in progress. Please wait for it to finish.', 'error'); return; }
      if (file.size > MAX_UPLOAD_BYTES) { fileName.textContent = ''; setStatus('This file is larger than the 20 MB limit. Choose a smaller file.', 'error'); input.value = ''; return; }
      uploadBusy = true;
      input.disabled = true;
      dropzone?.classList.add('is-uploading');
      dropzone?.setAttribute('aria-busy', 'true');
      fileName.textContent = file.name; result.innerHTML = ''; setStatus('Uploading…');
      const form = new FormData(); form.append('reqtype', 'fileupload'); form.append('fileToUpload', file);
      input.value = '';
      if (isLitterbox) form.append('time', $('#expiry').value);
      const userhash = getCookie('userhash'); if (!isLitterbox && userhash) form.append('userhash', userhash);
      request = new XMLHttpRequest(); request.open('POST', isLitterbox ? '/litterbox/api.php' : '/user/api.php');
      request.setRequestHeader('X-Catbox-Async', '1');
      const finish = () => {
        uploadBusy = false;
        input.disabled = false;
        dropzone?.classList.remove('is-uploading');
        dropzone?.removeAttribute('aria-busy');
        request = null;
      };
      request.onabort = () => { if (progress) progress.hidden = true; setStatus('Upload cancelled.', 'error'); finish(); };
      if (progress) { progress.hidden = false; bar.style.width = '0%'; }
      request.upload.onprogress = event => { if (event.lengthComputable && progress) { bar.style.width = `${Math.round(event.loaded / event.total * 100)}%`; setStatus(`Uploading · ${Math.round(event.loaded / event.total * 100)}%`); } };
      request.onload = async () => {
        if (progress) progress.hidden = true;
        if (request.status === 202) {
          try {
            const job = JSON.parse(request.responseText);
            setStatus('Queued for upload…');
            const url = await pollJob(job.status_url, state => setStatus(state === 'uploading' ? 'Uploading to storage…' : 'Queued for upload…'));
            setStatus(isLitterbox ? 'Upload complete. This file will expire as selected.' : 'Upload complete.', 'success');
            showLink(url);
          } catch (error) { setStatus(error.message || 'The upload could not be completed.', 'error'); }
          finally { finish(); }
          return;
        }
        if (request.status < 200 || request.status >= 300) { setStatus(request.responseText || 'That upload didn’t work. Please try again.', 'error'); finish(); return; }
        setStatus(isLitterbox ? 'Upload complete. This file will expire as selected.' : 'Upload complete.', 'success'); showLink(request.responseText.trim()); finish();
      };
      request.onerror = () => { if (progress) progress.hidden = true; setStatus('Could not reach the server. Please try again.', 'error'); finish(); };
      try { request.send(form); }
      catch { if (progress) progress.hidden = true; setStatus('Could not start the upload. Please try again.', 'error'); finish(); }
    }
    input.addEventListener('change', () => upload(input.files?.[0]));
    ['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('is-dragging'); }));
    ['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove('is-dragging'); }));
    dropzone.addEventListener('drop', event => upload(event.dataTransfer.files?.[0]));
    urlPanel.addEventListener('submit', async event => {
      event.preventDefault(); const field = $('#file-url'); const button = urlPanel.querySelector('button[type="submit"]');
      if (uploadBusy) { setStatus('An upload is already in progress. Please wait for it to finish.', 'error'); return; }
      if (!field.reportValidity()) return;
      uploadBusy = true; button.disabled = true; setStatus('Fetching file…'); result.innerHTML = '';
      const body = new FormData(); body.append('reqtype', 'urlupload'); body.append('url', field.value);
      if (isLitterbox) body.append('time', $('#expiry').value);
      else if (getCookie('userhash')) body.append('userhash', getCookie('userhash'));
      try {
        const response = await fetch(isLitterbox ? '/litterbox/api.php' : '/user/api.php', {
          method: 'POST', body,
          headers: { 'X-Catbox-Async': '1' },
        });
        const output = (await response.text()).trim();
        if (response.status === 202) {
          const job = JSON.parse(output);
          setStatus('Queued for upload…');
          const url = await pollJob(job.status_url, state => setStatus(state === 'uploading' ? 'Uploading to storage…' : 'Queued for upload…'));
          setStatus(isLitterbox ? 'Upload complete. This file will expire as selected.' : 'Upload complete.', 'success');
          showLink(url);
          return;
        }
        if (!response.ok) { setStatus(output || 'Could not fetch that URL.', 'error'); return; }
        setStatus(isLitterbox ? 'Upload complete. This file will expire as selected.' : 'Upload complete.', 'success'); showLink(output);
      } catch { setStatus('Could not reach the server. Please try again.', 'error'); }
      finally { uploadBusy = false; button.disabled = false; }
    });
  }

  function initAuth() {
    const form = $('#auth-form'); if (!form) return;
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!form.reportValidity() || form.dataset.submitting === 'true') return; form.dataset.submitting = 'true';
      const mode = form.dataset.mode; const button = form.querySelector('button[type="submit"]'); const error = $('#auth-error');
      const previous = button.innerHTML; button.disabled = true; button.textContent = mode === 'login' ? 'Signing in…' : mode === 'register' ? 'Making your account…' : 'Working…'; error.textContent = '';
      const body = new URLSearchParams(new FormData(form)); const endpoint = mode === 'login' ? '/user/dologin.php' : mode === 'register' ? '/user/doregister.php' : '/user/reset_password.php';
      try {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        const message = await response.text();
        if (!response.ok) { error.textContent = message || 'That request could not be completed. Please try again.'; return; }
        if (mode === 'forgot') { error.style.color = 'var(--color-green)'; error.textContent = message; button.disabled = false; button.innerHTML = previous; return; }
        location.assign('/user/index.php');
      } catch { error.textContent = 'We couldn’t reach the server. Please try again.'; }
      finally { form.dataset.submitting = 'false'; if (button.disabled) { button.disabled = false; button.innerHTML = previous; } }
    });
  }
  function initContact() {
    const form = $('#contact-form'); if (!form) return;
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!form.reportValidity() || form.dataset.submitting === 'true') return; form.dataset.submitting = 'true'; const status = $('#contact-status'); const button = form.querySelector('button'); button.disabled = true; status.textContent = 'Saving your message…'; status.setAttribute('role', 'status');
      try {
        const response = await fetch('/do_contact.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(form)) });
        const message = await response.text(); status.textContent = message; status.dataset.kind = response.ok ? 'success' : 'error'; status.setAttribute('role', response.ok ? 'status' : 'alert');
        if (response.ok) form.reset();
      } catch { status.textContent = 'We couldn’t reach the server. Your message was not saved. Please try again.'; status.dataset.kind = 'error'; status.setAttribute('role', 'alert'); }
      finally { form.dataset.submitting = 'false'; button.disabled = false; }
    });
  }
  async function initAlbum() {
    const short = path.split('/').pop();
    try {
      const response = await fetch(`/api/albums/${encodeURIComponent(short)}`);
      if (!response.ok) throw new Error('This album may have moved, or the link might be mistyped.');
      const data = await response.json();
      document.title = `${data.album.title} · MewPocket`;
      app.innerHTML = `${header()}<main id="main" class="wrap"><section class="page-intro"><div><span class="eyebrow">A SMALL COLLECTION</span><h1>${esc(data.album.title)}</h1><p>${esc(data.album.description || `${data.files.length} file${data.files.length === 1 ? '' : 's'}, together in one place.`)}</p></div></section><section class="album-view">${data.files.length ? data.files.map(file => `<article class="album-file"><a href="${esc(file.url)}" target="_blank" rel="noopener">${file.mime.startsWith('image/') ? `<img class="album-image" src="${esc(file.url)}" alt="${esc(file.originalName)}" loading="lazy">` : `<span class="album-image" style="display:grid;place-items:center">${icon('file')}</span>`}<p>${esc(file.originalName)}</p></a></article>`).join('') : '<div class="empty-state" style="grid-column:1/-1"><h3>This album is empty for now.</h3></div>'}</section></main>${footer()}`;
      syncRenderedTheme();
    } catch (error) { app.innerHTML = `${header()}<main id="main" class="wrap page-404"><span class="eyebrow">NOT FOUND</span><h1>This album is taking a break.</h1><p class="muted">${esc(error.message)}</p><a class="button button-primary" href="/">Back to the upload page ${icon('arrow', true)}</a></main>${footer()}`; syncRenderedTheme(); }
  }

  function syncRenderedTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#221d27' : '#f3edf7');
    $$('[data-theme-toggle]').forEach(toggle => {
      toggle.textContent = dark ? 'Lights on!' : 'Go Dark?';
      toggle.setAttribute('aria-pressed', String(dark));
      toggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    });
  }

  function initTheme() {
    const isDark = /(?:^|;\s*)darktheme=1(?:;|$)/.test(document.cookie);
    const applyTheme = dark => {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      syncRenderedTheme();
    };
    applyTheme(isDark);
    document.addEventListener('click', event => {
      const toggle = event.target.closest('[data-theme-toggle]');
      if (!toggle) return;
      const dark = document.documentElement.dataset.theme !== 'dark';
      document.cookie = dark
        ? 'darktheme=1; Max-Age=2678400; Path=/; SameSite=Lax'
        : 'darktheme=; Max-Age=0; Path=/; SameSite=Lax';
      applyTheme(dark);
    });
  }

  const pageTitles = { home: 'Simple file sharing', litterbox: 'Temporary uploads', faq: 'Frequently asked questions', tools: 'Upload and sharing tools', legal: 'Terms and privacy', contact: 'Contact', login: 'Sign in', register: 'Create an account', forgot: 'Can’t sign in?', library: 'My files', albums: 'Albums', album: 'Shared album', notfound: 'Page not found' };
  document.title = `${pageTitles[page] || 'File sharing'} · MewPocket`;
  const descriptions = { home: 'Upload and share files. Files up to 20 MB, no account required.', litterbox: 'Upload a file and choose when its temporary sharing link expires.', faq: 'Answers about uploads, file links, account libraries, albums, and privacy.', tools: 'Upload files, create temporary links, and organize files into albums.', legal: 'Read how file links, storage, account data, and temporary file expiry work.', contact: 'Contact the site operator or report a file or broken link.' };
  const description = document.querySelector('meta[name="description"]');
  if (description && descriptions[page]) description.content = descriptions[page];

  if (page === 'home' || page === 'litterbox') { app.innerHTML = homeMarkup(isLitterbox); initHomeLayout(); initUpload(); }
  else if (page in pages) { app.innerHTML = renderStaticPage(pages[page]); if (page === 'contact') initContact(); }
  else if (page === 'login' || page === 'register' || page === 'forgot') { app.innerHTML = authMarkup(page); initAuth(); }
  else if (page === 'library') { app.innerHTML = renderLibrary(); initLibrary(); }
  else if (page === 'albums') { app.innerHTML = renderAlbums(); initAlbums(); }
  else if (page === 'album') initAlbum();
  else { app.innerHTML = `${header()}<main id="main" class="wrap page-404"><span class="eyebrow">404 · NOT FOUND</span><h1>Nothing here just yet.</h1><p class="muted">The page may have moved. Your files are safe.</p><a class="button button-primary" href="/">Back to the upload page ${icon('arrow', true)}</a></main>${footer()}`; }

 

  initTheme();

  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-menu-toggle]');
    if (!trigger) return;
    const nav = document.querySelector('[data-site-nav]');
    const expanded = trigger.getAttribute('aria-expanded') === 'true';
    trigger.setAttribute('aria-expanded', String(!expanded));
    trigger.setAttribute('aria-label', expanded ? 'Open navigation' : 'Close navigation');
    nav?.classList.toggle('is-open', !expanded);
  });

  $('#choose-file')?.addEventListener('click', () => $('#file-input')?.click());

  function $$(selector, root = document) { return [...root.querySelectorAll(selector)]; }
})();
