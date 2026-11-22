# Picos Baby

A shared baby log for two phones: feeds, diapers, sleep and important contacts.
Built for one-handed use at 3 AM. Works offline. Copies everything to Notion every hour.

## How it fits together

```
 Sergio's phone ──┐                       ┌── Ana Rita's phone
 (app + its own   │   Firebase database   │   (app + its own
  offline copy)   ├──►  (free plan)  ◄────┤    offline copy)
                  │          │            │
                  │          ▼            │
                  │   GitHub job, hourly  │
                  │          │            │
                  │          ▼            │
                  │   Notion: Feeds,      │
                  │   Diapers, Sleep,     │
                  │   Contacts            │
```

- **The app** is a web page installed to the home screen (a PWA). It lives in `app/`.
- **Each phone saves to itself first**, then sends to the shared database when there is signal.
  Closing the app or losing signal never loses an entry. The header says "Synced" or "N waiting to sync".
- **The database** is Google Firebase (Firestore), free plan. Both phones share one "family ID",
  a long random code that works like a key. There are no accounts or passwords.
- **Notion is a copy, not the source.** An hourly job on GitHub (`notion-sync/sync.mjs`) copies new
  and changed entries. Edit in the app, and the Notion page updates. Delete in the app, and the Notion page goes to the trash.
  Edits made directly in Notion are not copied back.

## Files

| Path | What it is |
|---|---|
| `app/index.html`, `app/styles.css` | The page and its look |
| `app/js/app.js` | Screens and buttons |
| `app/js/logic.js` | The maths: time since last feed, next side, today's totals |
| `app/js/db.js` | Saving and syncing |
| `app/config.js` | Your Firebase settings (the one file you edit) |
| `app/sw.js` | Makes the app open with no signal |
| `firestore.rules` | Who can read and write the database |
| `notion-sync/sync.mjs` | The hourly Notion copy |
| `.github/workflows/pages.yml` | Publishes the app to GitHub Pages |
| `.github/workflows/notion-sync.yml` | Runs the Notion copy every hour |
| `tests/` | Automatic checks (see below) |

## One-time setup (about 15 minutes)

### 1. Firebase (the shared database)
1. Go to https://console.firebase.google.com and click **Create a project**. Name it `picos-baby`. Turn Google Analytics off.
2. In the left menu: **Build → Firestore Database → Create database**. Pick the location closest to you, then **Start in production mode**.
3. Open the **Rules** tab, replace everything with the contents of `firestore.rules`, and click **Publish**.
4. Go to **Project settings** (gear icon) → **Your apps** → the **</>** (Web) button. Name it `picos`, skip Hosting, and click **Register app**.
5. Copy the `firebaseConfig` block it shows you and send it to Claude, or paste it into `app/config.js`. These values are not secret.

### 2. GitHub (hosting and the hourly job)
1. Create a new **public** repository called `picos-baby` with nothing in it, and tell Claude. Claude pushes the code.
2. In the repository: **Settings → Pages → Source: GitHub Actions**.
3. The app appears at `https://<your-username>.github.io/picos-baby/`.

**What being public shows, and what it doesn't.** Anyone can read the code, the Firebase settings in `app/config.js`
(these are public by design, since every visitor's browser downloads them anyway), and the first names Sergio and Ana Rita.
No entries, contacts, baby name, family ID or Notion secret are ever in the repository. Those live only on the phones,
in Firebase, and in GitHub's encrypted secrets.

### 3. Phones
1. On Sergio's phone, open the app link in **Chrome**. Enter the baby's name and birth (or due) date, and tap **Sergio**.
2. Chrome menu **⋮ → Add to home screen → Install**.
3. In the app: **⚙️ Settings → Share link**, and send it to Ana Rita.
4. Ana Rita opens it in Chrome, taps **Ana Rita**, and installs it the same way.

### 4. Notion copy
1. Go to https://www.notion.so/profile/integrations → **New integration**. Name it `Picos Baby`, type Internal. Copy the **secret**.
2. Open the **Picos Baby App** page in Notion → **⋯ → Connections → Picos Baby**.
3. In GitHub: **Settings → Secrets and variables → Actions → Secrets tab → New repository secret**, twice:
   - `NOTION_TOKEN`: the Notion secret
   - `FAMILY_ID`: from the app's **Settings → Sync** section
   Use the **Secrets** tab, not Variables: this repository is public and variables can show up in public logs.
4. **Actions → Copy to Notion → Run workflow** to try it straight away. After that it runs every hour.

## Using it

- **Feed**: tap Feed, then Left or Right. The timer starts and the big button becomes **Stop feed**.
  After stopping, the message offers **Start Right** (or Left) to switch sides in one tap.
  The suggested side is the opposite of the last breast used. Bottle and Pump remember the last amount.
- **Diaper**: tap Diaper, then Wet, Dirty or Both. Pick a colour first if you want one.
- **Sleep**: one tap starts sleep, and the button turns into **Woke up**.
- **Forgot to log?** Every sheet has "5 / 15 / 30 min ago" and "Other…" at the top.
- **Mistake?** Every save shows **Undo** for 7 seconds. Tap any entry in the list to edit, add a note, or delete it.
- **Contacts**: the 📞 button. Each contact has a "When to call" line and a big Call button.
- **Look**: light by default. Settings → Look has "Dark at night" (8 PM to 7 AM) and "Dark".
- **Backup**: Settings → Download CSV.

## Costs and limits

Free. Firebase's free plan allows 50,000 reads and 20,000 writes a day. This app uses a few hundred to a few thousand.
GitHub Pages and GitHub Actions are free for public repositories. Nothing here needs a credit card.

## For developers: running the tests

```
npm install
npx firebase emulators:start --only firestore --project demo-picos   # needs Java
npm run serve                                                          # in a second terminal
npm test
```

- `tests/sync.test.mjs`: two phones, offline writes, closing the app while offline, edits from both phones, deletes, no duplicates.
- `tests/app.test.mjs`: the real screens on two simulated Android phones, end to end.
- `tests/notion.test.mjs`: the Notion copy against a fake Notion that checks every property name and option against the real databases.

While `projectId` in `app/config.js` is `REPLACE_ME` (or the URL has `?emu=1`), the app uses the local test database.

## Rule for this public repository

Nothing sensitive is ever committed here: no entries, contacts, baby name or birth date, family ID or invite link, tokens or keys, real email addresses or phone numbers, or screenshots with real data.
Those belong on the phones, in Firebase, or in GitHub's encrypted secrets. Any change that would break this rule is flagged to Sergio before it is committed.
