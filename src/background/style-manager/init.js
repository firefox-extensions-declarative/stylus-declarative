import {DB, kInjectionOrder, kResolve, UCD} from '@/js/consts';
import {onConnect, onDisconnect} from '@/js/msg';
import {STORAGE_KEY, set} from '@/js/prefs';
import * as colorScheme from '../color-scheme';
import {bgBusy, bgInit, onSchemeChange} from '../common';
import {db, draftsDB, execMirror, prefsDB} from '../db';
import './init';
import {fixKnownProblems, onSaved} from './fixer';
import {broadcastStyleUpdated, dataMap, setOrderImpl, storeInMap} from './util';
import {FIREFOX} from '@/js/ua';
import {buildCode, buildMeta, configVars} from '../usercss-manager';

bgInit.push(async () => {
  __.DEBUGLOG('styleMan init...');
  let mirrored;
  let [orderFromDb, styles] = await Promise.all([
    prefsDB.get(kInjectionOrder),
    db.getAll(),
  ]);
  if (!orderFromDb)
    orderFromDb = await execMirror(STORAGE_KEY, 'get', kInjectionOrder);
  if (!styles[0])
    styles = mirrored = await execMirror(DB, 'getAll');
  initStyleMap(styles, mirrored);
  setOrderImpl(orderFromDb, {store: false});
  initStyleMap(styles, mirrored);
  __.DEBUGLOG('styleMan init done');
  // declarative style stuff
  if (__.BUILD !== 'chrome' && FIREFOX && typeof browser.storage.managed === 'object') {
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
            fixedStyle[UCD]['vars'][variable]['value'] = managedStyleData.variables[variable];
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
});

onSchemeChange.add(() => {
  for (const {style} of dataMap.values()) {
    if (colorScheme.SCHEMES.includes(style.preferScheme)) {
      broadcastStyleUpdated(style, 'colorScheme');
    }
  }
});

// Using ports to reliably track when the client is closed, however not for messaging,
// because our `API` is much faster due to direct invocation.
onDisconnect.draft = port => {
  if (__.MV3) port[kResolve]();
  const id = port.name.split(':')[1];
  draftsDB.delete(+id || id).catch(() => {
  });
};

onDisconnect.livePreview = port => {
  if (__.MV3) port[kResolve]();
  const id = +port.name.split(':')[1];
  const data = dataMap.get(id);
  if (!data) return;
  data.preview = null;
  broadcastStyleUpdated(data.style, 'editPreviewEnd');
};

if (__.MV3) {
  onConnect.draft = onConnect.livePreview = port => {
    __.KEEP_ALIVE(new Promise(resolve => {
      port[kResolve] = resolve;
    }));
  };
}

async function initStyleMap(styles, mirrored) {
  let fix, fixed, lost, i, style, len;
  for (i = 0, len = 0, style; i < styles.length; i++) {
    style = styles[i];
    if (+style.id > 0
    && typeof style._id === 'string'
    && typeof style.sections?.[0]?.code === 'string') {
      storeInMap(style);
      if (mirrored) {
        if (i > len) styles[len] = style;
        len++;
      }
    } else {
      try { fix = fixKnownProblems(style, true); } catch {}
      if (fix) (fixed ??= new Map()).set(style.id, fix);
      else (lost ??= []).push(style);
    }
  }
  styles.length = len;
  if (lost)
    console.error(`Skipped ${lost.length} unrecoverable styles:`, lost);
  if (fixed) {
    console[mirrored ? 'log' : 'warn'](`Fixed ${fixed.size} styles, ids:`, ...fixed.keys());
    fixed = await Promise.all([...fixed.values(), bgBusy]);
    fixed.pop();
    if (mirrored) {
      styles.push(...fixed);
      fixed.forEach(storeInMap);
    }
  }
  if (styles.length)
    setTimeout(db.putMany, 100, styles);
}
