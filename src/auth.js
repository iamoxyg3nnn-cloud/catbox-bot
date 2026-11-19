'use strict';

// Account lifecycle: registration, login, session cookies, password reset.
//
// All DB calls are awaited so this module works with both the synchronous
// SQLite adapter and the asynchronous Supabase/PostgREST adapter.

const { config } = require('./config');
const db = require('./dbAdapter');
const { hashPassword, verifyPassword, randomUserhash, isValidEmail, parseCookies } = require('./util');

const SESSION_COOKIE = 'catsess';
const USERHASH_COOKIE = 'userhash';

async function startSession(res, user) {
  const { token, expiresAt } = await db.createSession(user.id, config.sessionTtlMs);
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`);
  // The userhash cookie is deliberately readable from JS: the upload form
  // reads it to tag uploads with the account, same as the reference client.
  res.append('Set-Cookie', `${USERHASH_COOKIE}=${encodeURIComponent(user.userhash)}; Path=/; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`);
}

async function endSession(req, res) {
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE]) await db.destroySession(cookies[SESSION_COOKIE]);
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.append('Set-Cookie', `${USERHASH_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`);
}

// Discards the pre-login session and starts a fresh one. Prevents session
// fixation: a token planted in a victim's browser before sign-in is invalid
// once the password is accepted.
async function rotateSession(req, res, user) {
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE]) await db.destroySession(cookies[SESSION_COOKIE]);
  return startSession(res, user);
}

// Attaches req.user for the current request, if any. Calls next(err) on a
// backend failure so Express can return a 500 instead of hanging.
async function sessionMiddleware(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const session = await db.getSession(cookies[SESSION_COOKIE]);
    req.user = session ? await db.findUserById(session.user_id) : null;
    req.userhash = (req.user && req.user.userhash) || cookies[USERHASH_COOKIE] || '';
    next();
  } catch (err) {
    next(err);
  }
}

async function registerUser({ username, email, password }) {
  const errors = [];
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,25}$/.test(name)) errors.push('Username must be 3-25 letters, numbers or underscores.');
  if (!isValidEmail(email)) errors.push('That email address does not look valid.');
  if (String(password || '').length < 8) errors.push('Password must be at least 8 characters.');
  if (name && name.toLowerCase() === String(email || '').toLowerCase()) {
    errors.push('Username cannot be the same as your email.');
  }
  if (errors.length) return { errors };

  if (await db.findUserByName(name)) return { errors: ['That username is taken.'] };
  if (await db.findUserByEmail(email)) return { errors: ['An account with that email already exists.'] };

  const userhash = randomUserhash();
  const id = await db.createUser(name, email, hashPassword(password), userhash);
  return { user: await db.findUserById(id) };
}

async function authenticate(username, password) {
  const user = await db.findUserByName(String(username || '').trim());
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

module.exports = {
  SESSION_COOKIE, USERHASH_COOKIE,
  startSession, endSession, rotateSession, sessionMiddleware,
  registerUser, authenticate,
};
