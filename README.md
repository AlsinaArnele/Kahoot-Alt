# QUIZ ARENA GitHub Pages Static UI

This package hosts the **front end only** on GitHub Pages.

- `host.html` = stadium host / jumbotron view
- `play.html` = player join / controller view
- Supabase stores the live game state, players, answers, scoring, and realtime updates

## 1) Configure `config.js`

Edit `config.js` and paste your Supabase values:

- `supabaseUrl`
- `anonKey`

The browser uses the anon key only. Never put the Supabase service-role key in the frontend.

## 2) Open the site

For local testing, use a static server (for example, `python -m http.server`).

For GitHub Pages, publish the repository root.

## 3) Host a room

Open:

- `host.html`

The first time, paste the current **Game PIN** and **Host Token** for your Supabase room. They are stored in your browser only.

## 4) Player join URL / QR code

The host page generates a link like:

- `play.html?pin=123456`

The QR code points to the same link.

## 5) Supabase setup

Run the SQL migration in `supabase/migrations/0001_quiz_arena_supabase_backend.sql` in the Supabase SQL Editor if you have not already.

## 6) GitHub Pages

1. Create a GitHub repository.
2. Upload these files to the repository root.
3. In **Settings → Pages**, choose the branch and root folder.
4. Save and wait for deployment.

## URLs

- Host: `host.html`
- Player: `play.html?pin=GAMEPIN`

## Notes

- The static UI does not depend on Apps Script for live gameplay.
- If you still use Apps Script for Sheets import/export, keep that separate from this frontend.
