// Test-only entry: real sheet and stylesheet, with no host or payment actions.
import { render } from 'solid-js/web';
import { FirstSpendSheet } from '../../src/control/FirstSpendSheet';
import { SAMPLE_PRESETS } from '../../src/control/sample';
import { setLanguagePref } from '../../src/i18n';
import '../../src/styles.css';
const params = new URLSearchParams(location.search);
const locale = params.get('lang') === 'da' ? 'da' : 'en';
setLanguagePref(locale);
document.documentElement.lang = locale;
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
render(() => <FirstSpendSheet presets={SAMPLE_PRESETS} initialPreset="careful" maxDailyMsat={100_000_000}
  costLine="" blockedReason={null} onPreset={() => {}} onAllow={() => {}} onCancel={() => {}} />,
  document.getElementById('root')!);
