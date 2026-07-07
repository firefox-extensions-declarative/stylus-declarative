import {DB, kInjectionOrder, kResolve, STORAGE_KEY, UCD} from '@/js/consts';
import {onConnect, onDisconnect} from '@/js/msg';
import {set} from '@/js/prefs';
import {styleJSONseemsValid} from '@/js/style-util';
import {NOP} from '@/js/util';
import {ignoreChromeError} from '@/js/util-webext';
import {FIREFOX} from '@/js/ua';
import {buildCode, buildMeta, configVars} from '../usercss-manager';
import * as colorScheme from '../color-scheme';
import {bgInit, onSchemeChange} from '../common';
import {db, draftsDB, execMirror, prefsDB} from '../db';
import './init';
import {fixKnownProblems, onSaved} from './fixer';
import {broadcastStyleUpdated, setOrderImpl, storeInMap, styleMap, stylePreviewMap} from './util';

export const badStyles = [];
const rxVarsAndImport = /^:root\s*{\s+--[\s\S].*?@import\s/i;
const hasVarsAndImport = ({code}) => rxVarsAndImport.test(code);

bgInit.push(async () => {
  await initStyleMap();
  await initManagedSettings();
});

onSchemeChange.add(() => {
  for (const style of styleMap.values()) {
    if (colorScheme.SCHEMES.includes(style.preferScheme)) {
      broadcastStyleUpdated(style, 'colorScheme');
    }
  }
});

// Using ports to reliably track when the client is closed, however not for messaging,
// because our `API` is much faster due to direct invocation.
onDisconnect.draft = port => {
  ignoreChromeError();
  if (__.MV3) port[kResolve]();
  const id = port.name.split(':')[1];
  draftsDB.delete(+id || id).catch(NOP);
};

onDisconnect.livePreview = port => {
  ignoreChromeError();
  if (__.MV3) port[kResolve]();
  const id = +port.name.split(':')[1];
  const style = styleMap.get(id);
  if (!style) return;
  stylePreviewMap.delete(id);
  broadcastStyleUpdated(style, 'editPreviewEnd');
};

if (__.MV3) {
  onConnect.draft = onConnect.livePreview = port => {
    __.KEEP_ALIVE(new Promise(resolve => {
      port[kResolve] = resolve;
    }));
  };
}

async function initManagedSettings() {
  if (!__.B_FIREFOX || !FIREFOX || typeof browser.storage.managed !== 'object') return;
  try {
    const managedSettings = await browser.storage.managed.get(null);
    if (managedSettings?.prefs) {
      const managedPrefs = managedSettings.prefs;
      for (const managedPrefName in managedPrefs) {
        set(managedPrefName, managedPrefs[managedPrefName]);
      }
    }
    if (managedSettings?.styles) {
      const managedStyles = managedSettings.styles;
      for (const managedStyleData of managedStyles) {
        let newId = 1;
        const currentStyles = await db.getAll();
        const takenIds = currentStyles.map(style => style.id);
        const managedStyle = await buildMeta({sourceCode: managedStyleData.code});
        for (const style of currentStyles) {
          if (style.name === managedStyle.name) {
            newId = style.id;
            break;
          }
          if (!takenIds.includes(style.id + 1)) {
            newId = style.id + 1;
            break;
          }
        }
        const styleWithSectionsAndId = {
          ...managedStyle,
          sections: await buildCode(managedStyle),
          id: newId,
        };
        const fixedStyle = await fixKnownProblems(styleWithSectionsAndId, true);
        for (const variable in managedStyleData.variables || {}) {
          fixedStyle[UCD].vars[variable].value = managedStyleData.variables[variable];
        }
        await db.put(fixedStyle);
        await onSaved(fixedStyle);
        await configVars(fixedStyle.id, fixedStyle[UCD].vars);
      }
    }
  } catch (err) {
    console.error(`page.initSettings: ${err}`);
  }
}

async function initStyleMap() {
  __.DEBUGLOG('styleMan init...');
  let [orderFromDb, styles] = await Promise.all([
    prefsDB.get(kInjectionOrder),
    db.getAll(),
  ]);
  let mirror;
  if (!orderFromDb)
    orderFromDb = await execMirror(STORAGE_KEY, 'get', kInjectionOrder).catch(console.error);
  if (!styles.length && (mirror = await execMirror(DB, 'getAll').catch(console.error)))
    styles = mirror;
  for (const style of styles) {
    let err;
    try {
      fixKnownProblems(style, true);
      err = (!Array.isArray(style.sections) ||
        /* @import must precede `vars` that we add at beginning */
        style[UCD]?.vars && style.sections.some(hasVarsAndImport)
      ) && (
        !style.sourceCode && 'No sourceCode' ||
        !await buildCode(style) // throws on errors
      ) || !styleJSONseemsValid(style) && 'No name/code';
    } catch (e) {
      err = e;
    }
    if (err) badStyles.push([err, style]);
    else storeInMap(style);
  }
  if (badStyles.length) console.warn(badStyles);
  if (mirror?.length) setTimeout(db.putMany, 100, mirror);
  setOrderImpl(orderFromDb, {store: false});
  __.DEBUGLOG('styleMan init done');
}
