# Yahoo attribution: implementation record (research branch only)

Branch `research/projection-v2-data-rights` in the `ProGM-projection-v2` worktree. Not pushed, merged or deployed. OAuth behavior, Yahoo connection buttons, button colors and the number of Yahoo API requests are unchanged. The three-request Yahoo probe was **not run** (you have not confirmed the local sign-in).

## 1. Logo gate: what could and could not be established

| Question | Evidence (read 2026-10-20) | Result |
|---|---|---|
| Is an official logo required? | Yahoo Fantasy developer page, "ATTRIBUTION REQUIREMENTS": "Include the official logo whenever referencing or using Yahoo Fantasy Sports API information." | **Yes** |
| May it be displayed from Yahoo's published file? | The same page links the official `Yahoo_Fantasy.svg` for exactly this purpose and says "Use the word marks and logos only as provided." | **Yes** (use as provided) |
| May a copy be **bundled** (self-hosted) in ProGM? | The page says nothing about downloading, copying or hosting. The Yahoo Developer API Terms (§3) reserve all rights not expressly granted and contain no trademark licence; Yahoo's permissions page says logo use otherwise needs written permission and mentions no exception for API developers. | **Not established** |
| May the file's empty margin be trimmed? | Not addressed. Rules forbid altering colors, proportions, effects or adding elements. | **Not established**; see below |

Per your instruction not to substitute a homemade logo, **nothing was drawn or copied.** Because bundling cannot be established, the component references the logo at the URL Yahoo itself publishes instead of copying it into the repository. That needs no copying right and uses the file "as provided". Changing to a bundled copy later is one constant (`YAHOO_FANTASY_LOGO_URL`). If you want a strict stop until Yahoo answers, revert the five view changes; the component is inert on its own.

**Trimming the margin: decided.** You approved `TRIM_EMPTY_MARGIN = false`. The component now shows the **full, untrimmed official canvas**, exactly as provided: a uniform square (112 px for the compact variant, 144 px for the standard one), no cropping, no `object-fit`, no recoloring. On the dark theme the wordmark reads clearly at 144 px and is small but readable at 112 px (checked with a rendered preview). Setting the constant to `true` would restore the wide, trimmed frame, but that is not recommended until Yahoo confirms it.

## 2. What was built

`client/src/components/YahooAttribution.js` (plain JS with `createElement`, like the repo's other unit-tested shared components):
- the official logo, unmodified, on a plain white plate with a hairline ring (needed because the SVG uses dark and purple fills and is designed for light backgrounds; the plate also keeps it legible in ProGM's dark theme and is invisible against light surfaces);
- the exact wording "Fantasy data provided by Yahoo Fantasy" (optional via `showText={false}`);
- the logo links to `https://www.yahoo.com/?ilc=401` (Yahoo's general attribution guideline) with `target="_blank" rel="noopener noreferrer"`; the image uses `referrerPolicy="no-referrer"` and lazy loading; accessible name "Yahoo Fantasy (opens yahoo.com in a new tab)"; alt text and the sentence remain if the image cannot load;
- sizes `md` (144 px square) and `sm` (112 px square); wraps on narrow screens.

Placements (one component, five places, each once per view):

| # | Place | Change |
|---|---|---|
| 1 | Basketball workspace (`pages/BasketballWorkspace.jsx`) | One strip below the active tab, so it covers every tab (Standings, Roster, Start/Sit, Trades, Waivers, Rankings, Draft Helper, League Hub, Ask ProGM). The outdated "Yahoo is invisible" comment was updated. |
| 2 | Player profile dialog (`components/BasketballPlayerProfile.jsx`) | Compact footer (the dialog covers the page strip and shows Yahoo rank and ADP). |
| 3 | Sync Your League (`pages/YahooFantasy.jsx`) | The official logo plus wording replaces the hand-made "Y!" box in the header; the duplicate "Y!" tile in the connect card was removed (the header already shows the logo). The "Continue with Yahoo" button is untouched. |
| 4 | Login Yahoo panel (`pages/Login.jsx`) | The official logo (no sentence) replaces the hand-made "Y!" tile, shown above the heading. The "Connect Yahoo Fantasy" button and purple panel are untouched. |
| 5 | Home (`pages/Home.jsx`) | A compact line under the Fantasy Basketball section only (its cards are built from Yahoo league data). Not shown for football (ESPN). |

Not added: any per-row, per-column or per-card branding; no global footer; Settings and football untouched.

## 3. Verification

- **Unit tests** (`YahooAttribution.test.js`, 6 new): exact wording; official URL; safe link attributes and accessible name; no filter, recolor, rotation, stretching or inline/homemade SVG; the full square with equal height and width and no cropping; logo-only mode.
- **Client suite:** 57 of 57 pass (47 existing, 6 for this component, 4 for AI data sharing). **Production build:** compiles.
- **Server suite:** 642 of 642 pass. **Probe tests:** 17 of 17 pass.
- **Visual check** (real component, built stylesheet): legible on the dark theme and the light theme, at the login-panel, sync-header, workspace-strip, profile-footer and 320 px layouts. A first version had an unreadably small logo and a flex-shrink overlap with the Login heading; both were found in this check and fixed.
- **Not visually verified in the running app:** the workspace, profile dialog, Sync and Home views behind login (they need a Yahoo-connected account). Their markup is a single component call each, covered by the build and unit tests.

## 4. Remaining questions for Yahoo (also in the email draft)
Which attribution policy governs the Fantasy API; whether the logo may be bundled; whether one strip per view is sufficient; whether values ProGM derives from Yahoo league data need attribution; whether Yahoo rank and ADP may be displayed.
