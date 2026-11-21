// Title filters, shown as chips in the top bar after the channel and type chips.
// Click a chip to skip every video it matches (Prev/Next and the sidebar leave them out).
// Click it again to bring them back. Your on/off choice is saved with your progress.
//
// To add a filter, copy an entry and change it, then reload the page:
//   id       unique name; your on/off choice is saved under it, so don't rename it later
//   label    text on the chip
//   match    regular expression tested against the video title (/i = ignore case)
//   exclude  (optional) titles matching this are left out of the filter
//   channels (optional) only count videos from these channels: 'RT', 'AH', 'LP'
//   skip     (optional) true = skip these videos until you turn the chip back on
//
// Tip: search the sidebar for a word first to see which titles it would catch.

window.TITLE_FILTERS = [
  {
    id: 'rvb',
    label: 'Red vs. Blue',
    channels: ['RT'],
    match: /red\s*vs\.?\s*blue|\brvb\b/i,
    exclude: /^RT Recap|RT Podcast/i,          // recaps / podcasts that only mention RvB
  },
  {
    id: 'ah-guides',
    label: 'Achievement Guides',
    match: /\bguides?\b|achievement walkthrough|collectibles/i,
    exclude: /ninja guides|guide to\b/i,       // "Ninja Guides - Party Hard", "Guide to Austin"
  },
];
