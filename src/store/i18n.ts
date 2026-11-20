type I18nDictionary = { [key: string]: { message: string } };

function fetchMessages(path: string): Promise<I18nDictionary | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.overrideMimeType("application/json");
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) {
        return;
      }
      if (xhr.status !== 200) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as I18nDictionary);
      } catch {
        resolve(null);
      }
    };
    xhr.onerror = () => resolve(null);
    xhr.open("GET", chrome.runtime.getURL(path));
    xhr.send();
  });
}

function activeLocalePath(): string | null {
  const uiLanguage = chrome.i18n?.getUILanguage?.() || "";
  const locale = uiLanguage.replace(/-/g, "_");
  if (!locale || locale.toLowerCase() === "en") {
    return null;
  }
  return `/_locales/${locale}/messages.json`;
}

export async function loadI18nMessages() {
  const localePath = activeLocalePath();
  const [fallback, localized] = await Promise.all([
    fetchMessages("/_locales/en/messages.json"),
    localePath ? fetchMessages(localePath) : Promise.resolve(null),
  ]);
  if (!fallback || Object.keys(fallback).length === 0) {
    throw new Error("Failed to load i18n messages.");
  }

  // chrome.i18n resolves a key that is missing from the active locale to the
  // default locale, so comparing the result with the English source tells us
  // whether a translation was actually found. When it was not, the active
  // locale file is the better source: pages read it from disk on every load,
  // while the message catalogue is cached from the last extension load and can
  // lag behind a rebuild.
  const i18nData: { [key: string]: string } = {};
  for (const key of Object.keys(fallback)) {
    const englishText = fallback[key].message;
    const localizedText = localized?.[key]?.message;
    const resolved = chrome.i18n.getMessage(key);

    if (resolved && resolved !== englishText) {
      i18nData[key] = resolved;
    } else {
      i18nData[key] = localizedText || resolved || englishText;
    }
  }
  return i18nData;
}
