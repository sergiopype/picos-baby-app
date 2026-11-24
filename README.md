# Picos Baby

A shared baby log for two phones: feeds, pumping and milk stock, diapers, sleep and important contacts.
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
                  │   Pumps, Milk Stock,  │
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

## Pump and milk stock

- **Pump** has its own button. Tap once to start the session timer, tap again to stop it: the card opens with
  the session length on top and a **Left** and a **Right** section. Each side has its ml (0 = not pumped),
  its own minutes (starts at the full session) and one or more bags. **+ Add bag** splits a side any way you
  like; a counter shows the ml still to put in a bag. Each bag has a place (Room temp, Fridge, Freezer) and a
  container (Bag, Bottle). Closing the card without saving keeps the session as "Finish pump".
- **Codes**: side, number, place letter: `L-004-B`. A = room temp, B = fridge, C = freezer. When a side has
  two or more bags in the same place, those are numbered instead: `L-004-1`, `L-004-2`, `L-004-C`.
  Records made before this rework keep their old `BPL-`/`BPR-` codes; numbering carries on from them.
- Numbers come from a counter in the database (`meta/milk`) taken inside a transaction, so both phones can save
  at once without clashing. With no signal the phone uses the highest number it knows + 1.
- **Milk stock** (the line above the big buttons) lists every bag oldest first with its use-by time:
  room temp 4 hours, fridge 4 days, freezer 6 months, thawed 24 hours from thawing. Bags close to it are flagged.
  Tap a bag to thaw it, change what's left, or discard it. Bags are stored in the `milk` collection.
- **Bottle** feeds take from stock: the bag that expires first is preselected, part of a bag can be used,
  and any other bag can be picked. Formula is a small option for when it's needed.

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
- **Sleep**: one tap on Sleep starts the timer and opens the sleep card, so you set the details while it counts:
  Day ☀️ / Night 🌙 (preset from the clock, 7 AM to 7 PM is day), Cover (Swaddle, Sleeping bag, Blanket), Where (Bedside bassinet, Crib, Cot, Other),
  Sound (Silence, White noise, Music), Night light, and Room temperature (always starts at 23 °C). Cover, place, sound and night light repeat the last sleep.
  Fell asleep earlier? Tap "5 / 15 / 30 min earlier" in the card. Close the card any time; the sleep keeps counting.
  To stop, tap the home button (now **Woke up**) to reopen the card, then **Woke up · stop**.
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
