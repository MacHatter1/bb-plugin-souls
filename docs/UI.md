# Souls UI direction

The audience is people managing reusable agent personas inside BB. The main
jobs are to recognize a soul, understand how it works, and choose its authority
without losing the persona in configuration.

## Visual contract

The pixel portrait is the identifying element. Everything around it is quiet:
left-aligned text, a clear name, restrained dividers and native BB controls.
No remote fonts, decorative gradients or new color literals. BB owns the palette
and typography, including custom themes. The base palette maps to background,
foreground, muted, muted-foreground, border and ring; the current light theme
is white, charcoal and neutral grays. Portraits supply each soul's color.

Use BB's UI font for names, prose and controls; monospace only for the exact
agent preview and structured diffs. Names are 24px, section titles 14px, body
14px with generous line height, and supporting labels 12px. Keep prose below
approximately 75 characters per line where space allows.

## Layout

The library is a directory with a readable profile, not a dashboard.

```text
Your souls                                      Import
Search              portrait  Name
All / In use                  Description and usage
                    Persona   Team   History
portrait Name       ----------------------------------
         Job        Focused content for the selected view
portrait Name
```

The editor separates Persona, Team and Appearance. Its header and Save changes
action remain fixed; only the working area scrolls. The full agent preview is a
quiet sidebar on wide screens and a disclosure on smaller ones. Import review
keeps the complete imported instructions and its Back action.

The thread picker pairs a searchable directory with settings for the selected
soul. Selection, delegation, hiring and persona-version choices remain drafts
until Apply soul. Narrow screens stack the two areas and keep Apply visible.

Team settings show permissions, preferred specialists, limits and briefings.
History uses dated revision rows and a readable comparison before restore.
Archive and promotion stay separate from persona editing.

Creation starts with one portrait-led interview option and a pair of quieter
import/manual choices. Conversation cards and composer banners reuse the compact
portrait identity instead of large decorative covers. Their labels distinguish
selection and version evidence from agent compliance. Empty detail groups stay
out of the card; populated groups expand in place.

Approval cards separate Persona and Permissions so the decision area remains
reachable in short windows. The footer summarizes both saved defaults and the
effect on this thread before approval. Drafts and permission choices persist
between the two views.

## Review and verification

The initial temptation was another set of cards for every new feature. The
chosen design instead separates different tasks with tabs and groups related
settings under plain headings. Borders explain selection or grouping; portraits
carry identity. No new animation is needed.

Verify keyboard tab navigation, compact library drill-down, fixed dialog
actions, native model picker behavior, draft retention between tabs, readable
history, and theme inheritance in the live app. Opening any view starts no
agent or model run.
