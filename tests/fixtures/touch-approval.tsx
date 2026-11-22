// Real disclosure and CSS; no host, biometric, or payment calls.
import { render } from 'solid-js/web';
import { TouchApproval } from '../../src/control/Shell';
import { setLanguagePref } from '../../src/i18n';
import '../../src/styles.css';
const lang = new URLSearchParams(location.search).get('lang') === 'da' ? 'da' : 'en';
setLanguagePref(lang);
document.documentElement.lang = lang;
render(() => <main><TouchApproval peer={'a'.repeat(64)} name="Robin" priceMsat={6000} actions={{} as never} /></main>, document.getElementById('root')!);
