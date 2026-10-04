// Design directions for the BitSov mocks. Each direction is a token set (light +
// dark) plus layout variants for the three mocked screens. Palettes borrow
// Radix Colors (MIT) and Catppuccin (MIT) values where noted; fonts are OFL.
window.DIRECTIONS = {
  A: {
    name: 'Quiet Instrument',
    tagline: 'Greyscale tool; orange appears only where sats move.',
    primary: 'light',
    fonts: { ui: "'Geist', system-ui, sans-serif", display: "'Geist', system-ui, sans-serif", mono: "'Geist Mono', ui-monospace, monospace" },
    radius: '6px', radiusLg: '10px', bubbleRadius: '10px', density: 'compact', dur: '160ms',
    variants: { onboarding: 'card', price: 'chip', wallet: 'hero', bubbles: 'flat' },
    light: { bg: '#f4f5f7', rail: '#eceef1', surface: '#ffffff', raised: '#f0f1f3', line: '#dfe1e6', ink: '#1c2024', muted: '#60646c', faint: '#8b8d98', accent: '#1c2024', accentInk: '#ffffff', money: '#e2570b', moneyBg: '#fff1e7', ok: '#218358', bubbleIn: '#ffffff', bubbleInInk: '#1c2024', bubbleOut: '#1c2024', bubbleOutInk: '#f4f5f7' },
    dark: { bg: '#111113', rail: '#18191b', surface: '#1d1e21', raised: '#232428', line: '#2e3135', ink: '#edeef0', muted: '#b0b4ba', faint: '#777b84', accent: '#edeef0', accentInk: '#111113', money: '#ff801f', moneyBg: '#2a1a0d', ok: '#3dd68c', bubbleIn: '#1d1e21', bubbleInInk: '#edeef0', bubbleOut: '#edeef0', bubbleOutInk: '#111113' },
  },
  B: {
    name: 'Ledger Paper',
    tagline: 'Account-book calm: green ledger paper, navy ink, receipts for every act.',
    primary: 'light',
    fonts: { ui: "'IBM Plex Sans', system-ui, sans-serif", display: "'Fraunces', Georgia, serif", mono: "'IBM Plex Mono', ui-monospace, monospace" },
    radius: '8px', radiusLg: '14px', bubbleRadius: '4px 14px 14px 14px', density: 'airy', dur: '280ms',
    variants: { onboarding: 'letter', price: 'note', wallet: 'ledger', bubbles: 'paper' },
    light: { bg: '#edf1ea', rail: '#e3e9df', surface: '#f9fbf7', raised: '#e8eee4', line: '#c9d4c2', ink: '#1d2a3a', muted: '#4f5d6b', faint: '#7d8a86', accent: '#1d2a3a', accentInk: '#f9fbf7', money: '#c4470c', moneyBg: '#f8e6d9', ok: '#2f6b45', bubbleIn: '#f9fbf7', bubbleInInk: '#1d2a3a', bubbleOut: '#dbe5f0', bubbleOutInk: '#1d2a3a' },
    dark: { bg: '#141a17', rail: '#18201c', surface: '#1c2621', raised: '#223029', line: '#33443b', ink: '#e4ebe4', muted: '#a3b2a8', faint: '#738279', accent: '#e4ebe4', accentInk: '#141a17', money: '#f08a4b', moneyBg: '#33231a', ok: '#7cc894', bubbleIn: '#1c2621', bubbleInInk: '#e4ebe4', bubbleOut: '#24324a', bubbleOutInk: '#e4ebe4' },
  },
  C: {
    name: 'Wallet-native',
    tagline: 'Bitcoin Design Guide rules made visible: big balance, clear units, fee breakdown.',
    primary: 'dark',
    fonts: { ui: "'Inter', system-ui, sans-serif", display: "'Inter', system-ui, sans-serif", mono: "'Inter', system-ui, sans-serif" },
    radius: '999px', radiusLg: '18px', bubbleRadius: '16px', density: 'roomy', dur: '240ms',
    variants: { onboarding: 'wallet', price: 'review', wallet: 'hero', bubbles: 'soft' },
    light: { bg: '#ffffff', rail: '#f6f6f7', surface: '#f6f6f7', raised: '#ececee', line: '#e6e6e8', ink: '#111113', muted: '#6b6b72', faint: '#9a9aa2', accent: '#f7931a', accentInk: '#1a1206', money: '#b8640a', moneyBg: '#fff4e5', ok: '#218358', bubbleIn: '#f1f1f3', bubbleInInk: '#111113', bubbleOut: '#f7931a', bubbleOutInk: '#1a1206' },
    dark: { bg: '#0e0e10', rail: '#151517', surface: '#1a1a1c', raised: '#242427', line: '#2c2c30', ink: '#f2f2f3', muted: '#9a9aa2', faint: '#6b6b72', accent: '#f7931a', accentInk: '#1a1206', money: '#ffb547', moneyBg: '#2d2110', ok: '#3dd68c', bubbleIn: '#1f1f22', bubbleInInk: '#f2f2f3', bubbleOut: '#f7931a', bubbleOutInk: '#1a1206' },
  },
  D: {
    name: 'Signal-clear',
    tagline: 'Bright consumer messenger: big bubbles, friendly steps, price on the Send button.',
    primary: 'light',
    fonts: { ui: "'Inter', system-ui, sans-serif", display: "'Inter', system-ui, sans-serif", mono: "'Inter', system-ui, sans-serif" },
    radius: '12px', radiusLg: '20px', bubbleRadius: '20px', density: 'roomy', dur: '300ms',
    variants: { onboarding: 'chatty', price: 'button', wallet: 'card', bubbles: 'round' },
    light: { bg: '#ffffff', rail: '#f5f6f8', surface: '#ffffff', raised: '#eef0f3', line: '#e4e6ea', ink: '#14171c', muted: '#5d6470', faint: '#959ba6', accent: '#ef5f00', accentInk: '#ffffff', money: '#c24e00', moneyBg: '#ffefe2', ok: '#1f8a52', bubbleIn: '#eef0f3', bubbleInInk: '#14171c', bubbleOut: '#ef5f00', bubbleOutInk: '#ffffff' },
    dark: { bg: '#111215', rail: '#17181c', surface: '#1b1d21', raised: '#25272c', line: '#2e3036', ink: '#eef0f3', muted: '#a4a9b3', faint: '#6f7480', accent: '#ff801f', accentInk: '#17120e', money: '#ffa057', moneyBg: '#2b1b0e', ok: '#3dd68c', bubbleIn: '#25272c', bubbleInInk: '#eef0f3', bubbleOut: '#ff801f', bubbleOutInk: '#17120e' },
  },
  E: {
    name: 'Command Deck',
    tagline: 'Dense, keyboard-first node console. Every number visible, every action a shortcut.',
    primary: 'dark',
    fonts: { ui: "'Inter', system-ui, sans-serif", display: "'Inter', system-ui, sans-serif", mono: "'JetBrains Mono', ui-monospace, monospace" },
    radius: '4px', radiusLg: '6px', bubbleRadius: '0', density: 'dense', dur: '100ms',
    variants: { onboarding: 'checklist', price: 'statusbar', wallet: 'table', bubbles: 'log' },
    // Catppuccin Mocha / Latte (MIT)
    light: { bg: '#eff1f5', rail: '#e6e9ef', surface: '#ffffff', raised: '#dce0e8', line: '#ccd0da', ink: '#4c4f69', muted: '#6c6f85', faint: '#9ca0b0', accent: '#1e66f5', accentInk: '#eff1f5', money: '#fe640b', moneyBg: '#fde4d3', ok: '#40a02b', bubbleIn: 'transparent', bubbleInInk: '#4c4f69', bubbleOut: 'transparent', bubbleOutInk: '#4c4f69' },
    dark: { bg: '#1e1e2e', rail: '#181825', surface: '#232336', raised: '#313244', line: '#313244', ink: '#cdd6f4', muted: '#a6adc8', faint: '#6c7086', accent: '#89b4fa', accentInk: '#1e1e2e', money: '#fab387', moneyBg: '#3a2e33', ok: '#a6e3a1', bubbleIn: 'transparent', bubbleInInk: '#cdd6f4', bubbleOut: 'transparent', bubbleOutInk: '#cdd6f4' },
  },
  F: {
    name: 'Ember 2.0',
    tagline: 'Today’s warm BitSov, rebuilt on accessible scales, with orange kept for money and motion where payments settle.',
    primary: 'dark',
    fonts: { ui: "'Inter', system-ui, sans-serif", display: "'Instrument Serif', Georgia, serif", mono: "'JetBrains Mono', ui-monospace, monospace" },
    radius: '10px', radiusLg: '16px', bubbleRadius: '16px', density: 'medium', dur: '200ms',
    variants: { onboarding: 'card', price: 'chip', wallet: 'hero', bubbles: 'soft' },
    // Radix sand-dark / orange-dark + sand / orange (MIT), warmed toward today's palette
    light: { bg: '#fbfaf8', rail: '#f3f1ed', surface: '#ffffff', raised: '#f0eee9', line: '#dad7d0', ink: '#21201c', muted: '#63635e', faint: '#8d8b84', accent: '#21201c', accentInk: '#fbfaf8', money: '#cc4e00', moneyBg: '#ffefd6', ok: '#2a7e4f', bubbleIn: '#f0eee9', bubbleInInk: '#21201c', bubbleOut: '#2b2722', bubbleOutInk: '#f6f2ec' },
    dark: { bg: '#13110f', rail: '#181513', surface: '#1e1b18', raised: '#27231f', line: '#363029', ink: '#efebe5', muted: '#b5afa6', faint: '#7e776d', accent: '#efebe5', accentInk: '#13110f', money: '#ff9a4d', moneyBg: '#331e0b', ok: '#5bc98a', bubbleIn: '#27231f', bubbleInInk: '#efebe5', bubbleOut: '#3a2c20', bubbleOutInk: '#f6ece1' },
  },
};
