/**
 * Per-context capability used to reach an immutable collector installed before
 * page script. The random name prevents a page from pre-registering a forged
 * collector; the installed property and API are non-configurable/read-only.
 */
export function createBoundedPageCollectorKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `__sbl_bounded_page_${hex}`;
}

/**
 * Playwright serializes this function into every new document before site JS.
 * Keep it self-contained: every DOM getter and intrinsic used later is captured
 * now, before the page can replace prototypes or install hostile own getters.
 */
export function installBoundedPageCollector(key: string): void {
  type NativeCallable = (...args: any[]) => any;
  const nativeApply = Reflect.apply;
  const nativeCreate = Object.create;
  const nativeDefine = Object.defineProperty;
  const nativeFreeze = Object.freeze;
  const nativeGetOwnDescriptor = Object.getOwnPropertyDescriptor;
  const nativeGetPrototypeOf = Object.getPrototypeOf;
  const nativeJsonStringify = JSON.stringify;
  const nativeArrayPush = Array.prototype.push;
  const nativeStringSlice = String.prototype.slice;
  const nativeStringTrim = String.prototype.trim;
  const nativeStringLower = String.prototype.toLowerCase;
  const nativeStringIndexOf = String.prototype.indexOf;
  const nativeStringCharCodeAt = String.prototype.charCodeAt;
  const nativeNumberIsSafeInteger = Number.isSafeInteger;

  const findDescriptor = (target: object | null, name: string): PropertyDescriptor | null => {
    let current: object | null = target;
    while (current) {
      const descriptor = nativeGetOwnDescriptor(current, name);
      if (descriptor) return descriptor;
      current = nativeGetPrototypeOf(current);
    }
    return null;
  };
  const getter = (target: object | null, name: string): NativeCallable | null => {
    const candidate = findDescriptor(target, name)?.get;
    return typeof candidate === "function" ? candidate : null;
  };
  const method = (target: object | null, name: string): NativeCallable | null => {
    const candidate = findDescriptor(target, name)?.value;
    return typeof candidate === "function" ? candidate : null;
  };
  const call = (candidate: NativeCallable | null, receiver: unknown, args: unknown[]) => {
    if (!candidate) throw new Error("collector primitive unavailable");
    return nativeApply(candidate, receiver, args);
  };
  const set = (target: object, name: string, value: unknown, enumerable = true) => {
    nativeDefine(target, name, {
      value,
      enumerable,
      configurable: false,
      writable: false
    });
  };
  const record = (): Record<string, unknown> => nativeCreate(null) as Record<string, unknown>;
  const list = (): unknown[] => {
    const value: unknown[] = [];
    set(value, "toJSON", undefined, false);
    return value;
  };
  const push = (target: unknown[], value: unknown) => {
    nativeApply(nativeArrayPush, target, [value]);
  };
  const stringify = (value: unknown): string => nativeJsonStringify(value) ?? "";
  const boundedPositiveInteger = (value: unknown, ceiling: number): number | null =>
    typeof value === "number" &&
    nativeNumberIsSafeInteger(value) &&
    value > 0 &&
    value <= ceiling
      ? value
      : null;

  const windowDocumentGetter = getter(globalThis, "document");
  const localStorageGetter = getter(globalThis, "localStorage");
  const sessionStorageGetter = getter(globalThis, "sessionStorage");
  const documentObject = windowDocumentGetter
    ? call(windowDocumentGetter, globalThis, []) as object
    : null;
  const documentTitleGetter = getter(documentObject, "title");
  const documentLinksGetter = getter(documentObject, "links");
  const documentBodyGetter = getter(documentObject, "body");
  const storagePrototype = typeof Storage === "function" ? Storage.prototype : null;
  const storageLengthGetter = getter(storagePrototype, "length");
  const storageKey = method(storagePrototype, "key");
  const storageGetItem = method(storagePrototype, "getItem");
  const collectionPrototype = typeof HTMLCollection === "function" ? HTMLCollection.prototype : null;
  const collectionLengthGetter = getter(collectionPrototype, "length");
  const collectionItem = method(collectionPrototype, "item");
  const anchorPrototype = typeof HTMLAnchorElement === "function" ? HTMLAnchorElement.prototype : null;
  const anchorHrefGetter = getter(anchorPrototype, "href");
  const nodePrototype = typeof Node === "function" ? Node.prototype : null;
  const nodeFirstChildGetter = getter(nodePrototype, "firstChild");
  const nodeNextSiblingGetter = getter(nodePrototype, "nextSibling");
  const nodeParentGetter = getter(nodePrototype, "parentNode");
  const nodeTypeGetter = getter(nodePrototype, "nodeType");
  const nodeValueGetter = getter(nodePrototype, "nodeValue");
  const elementPrototype = typeof Element === "function" ? Element.prototype : null;
  const elementTagNameGetter = getter(elementPrototype, "tagName");
  const elementGetAttribute = method(elementPrototype, "getAttribute");
  const htmlElementPrototype = typeof HTMLElement === "function" ? HTMLElement.prototype : null;
  const contentEditableGetter = getter(htmlElementPrototype, "isContentEditable");
  const blurMethod = method(htmlElementPrototype, "blur");

  const failWire = (kind: "title" | "storage" | "links" | "text"): string => {
    const output = record();
    if (kind === "title" || kind === "text") set(output, "value", "");
    if (kind === "storage") {
      set(output, "records", list());
      set(output, "omittedCount", 1);
    }
    if (kind === "links") set(output, "links", list());
    set(output, "truncated", true);
    return stringify(output);
  };

  const utf8Length = (value: string): number => {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = call(nativeStringCharCodeAt, value, [index]) as number;
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const next = call(nativeStringCharCodeAt, value, [index + 1]) as number;
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  };

  const boundedNodeText = (
    root: object,
    maxChars: number,
    maxNodes: number
  ): { value: string; truncated: boolean } => {
    let value = "";
    let visited = 0;
    let current = call(nodeFirstChildGetter, root, []) as object | null;
    let truncated = false;
    while (current && visited < maxNodes && value.length < maxChars) {
      visited += 1;
      if (call(nodeTypeGetter, current, []) === 3) {
        const nodeValue = call(nodeValueGetter, current, []);
        if (typeof nodeValue === "string") {
          const remaining = maxChars - value.length;
          value += call(nativeStringSlice, nodeValue, [0, remaining]) as string;
          if (nodeValue.length > remaining) truncated = true;
        }
      }
      const child = call(nodeFirstChildGetter, current, []) as object | null;
      if (child) {
        current = child;
        continue;
      }
      let advanced = false;
      while (current && current !== root) {
        const sibling = call(nodeNextSiblingGetter, current, []) as object | null;
        if (sibling) {
          current = sibling;
          advanced = true;
          break;
        }
        current = call(nodeParentGetter, current, []) as object | null;
      }
      if (!advanced) current = null;
    }
    if (current) truncated = true;
    return { value, truncated };
  };

  const api = record();
  set(api, "title", (maxCharsInput: unknown): string => {
    try {
      const maxChars = boundedPositiveInteger(maxCharsInput, 4_096);
      if (!maxChars) return failWire("title");
      const documentValue = call(windowDocumentGetter, globalThis, []);
      const title = call(documentTitleGetter, documentValue, []);
      const output = record();
      if (typeof title !== "string" || title.length > maxChars) {
        set(output, "value", "");
        set(output, "truncated", true);
      } else {
        set(output, "value", title);
        set(output, "truncated", false);
      }
      return stringify(output);
    } catch {
      return failWire("title");
    }
  });

  set(api, "storage", (input: unknown): string => {
    try {
      const limits = input as Record<string, unknown>;
      const maxRecords = boundedPositiveInteger(limits.maxRecords, 1_000);
      const maxKeyChars = boundedPositiveInteger(limits.maxKeyChars, 1_024);
      const maxTotalKeyChars = boundedPositiveInteger(limits.maxTotalKeyChars, 256 * 1_024);
      const maxTotalValueChars = boundedPositiveInteger(limits.maxTotalValueChars, 1_024 * 1_024);
      if (!maxRecords || !maxKeyChars || !maxTotalKeyChars || !maxTotalValueChars) {
        return failWire("storage");
      }
      const areas = list();
      const local = record();
      set(local, "area", call(localStorageGetter, globalThis, []));
      set(local, "name", "localStorage");
      push(areas, local);
      const session = record();
      set(session, "area", call(sessionStorageGetter, globalThis, []));
      set(session, "name", "sessionStorage");
      push(areas, session);
      const lengths = list() as number[];
      for (let index = 0; index < 2; index += 1) {
        const areaRecord = areas[index] as Record<string, unknown>;
        const length = call(storageLengthGetter, areaRecord.area, []);
        push(lengths, typeof length === "number" && nativeNumberIsSafeInteger(length) && length >= 0 ? length : 0);
      }
      const records = list();
      let omittedCount = 0;
      let totalKeyChars = 0;
      let totalValueChars = 0;
      let inspectedRows = 0;
      let stopped = false;
      const remainingRows = (areaIndex: number, itemIndex: number): number => {
        let remaining = lengths[areaIndex] - itemIndex;
        if (remaining < 0) remaining = 0;
        for (let later = areaIndex + 1; later < 2; later += 1) remaining += lengths[later];
        return remaining;
      };
      for (let areaIndex = 0; areaIndex < 2 && !stopped; areaIndex += 1) {
        const areaRecord = areas[areaIndex] as Record<string, unknown>;
        for (let index = 0; index < lengths[areaIndex]; index += 1) {
          if (inspectedRows >= maxRecords * 2) {
            omittedCount += remainingRows(areaIndex, index);
            stopped = true;
            break;
          }
          inspectedRows += 1;
          if (records.length >= maxRecords) {
            omittedCount += remainingRows(areaIndex, index);
            stopped = true;
            break;
          }
          const keyValue = call(storageKey, areaRecord.area, [index]);
          if (typeof keyValue !== "string" || keyValue.length > maxKeyChars) {
            omittedCount += 1;
            continue;
          }
          if (totalKeyChars + keyValue.length > maxTotalKeyChars) {
            omittedCount += remainingRows(areaIndex, index);
            stopped = true;
            break;
          }
          const stored = call(storageGetItem, areaRecord.area, [keyValue]);
          const value = typeof stored === "string" ? stored : "";
          if (totalValueChars + value.length > maxTotalValueChars) {
            omittedCount += remainingRows(areaIndex, index);
            stopped = true;
            break;
          }
          totalKeyChars += keyValue.length;
          totalValueChars += value.length;
          const output = record();
          set(output, "area", areaRecord.name);
          set(output, "key", keyValue);
          set(output, "valueBytes", utf8Length(value));
          push(records, output);
        }
      }
      const output = record();
      set(output, "records", records);
      set(output, "omittedCount", omittedCount);
      set(output, "truncated", omittedCount > 0);
      return stringify(output);
    } catch {
      return failWire("storage");
    }
  });

  set(api, "links", (input: unknown): string => {
    try {
      const limits = input as Record<string, unknown>;
      const maxCandidates = boundedPositiveInteger(limits.maxCandidates, 12);
      const maxHrefChars = boundedPositiveInteger(limits.maxHrefChars, 16_384);
      const maxInspected = boundedPositiveInteger(limits.maxInspected, 2_000);
      const maxTextChars = boundedPositiveInteger(limits.maxTextChars, 80);
      const maxMatchTextChars = boundedPositiveInteger(limits.maxMatchTextChars, 512);
      if (!maxCandidates || !maxHrefChars || !maxInspected || !maxTextChars || !maxMatchTextChars) {
        return failWire("links");
      }
      const documentValue = call(windowDocumentGetter, globalThis, []);
      const collection = call(documentLinksGetter, documentValue, []);
      const rawLength = call(collectionLengthGetter, collection, []);
      const length = typeof rawLength === "number" && nativeNumberIsSafeInteger(rawLength) && rawLength >= 0
        ? rawLength
        : maxInspected + 1;
      const links = list();
      let truncated = length > maxInspected;
      const inspected = length < maxInspected ? length : maxInspected;
      for (let index = 0; index < inspected; index += 1) {
        const anchor = call(collectionItem, collection, [index]);
        if (!anchor) continue;
        const href = call(anchorHrefGetter, anchor, []);
        if (typeof href !== "string" || href.length > maxHrefChars) {
          truncated = true;
          continue;
        }
        // Read far more text than is stored. The stored label is display copy
        // and stays short; the MATCH needs enough of the link to decide
        // whether it points at a privacy policy.
        //
        // Reading only the display budget made every long link label report
        // the whole candidate collection as truncated, and a page needs just
        // one such link to trigger it. Article teasers and headlines are
        // routinely longer than a display label, so on real pages this fired
        // constantly, censored the detector-output family, and marked the
        // privacy-policy detector partial on sites where nothing had gone
        // wrong. A clipped LABEL loses no candidate; only a match that could
        // be hiding past the read does.
        const textRead = boundedNodeText(anchor as object, maxMatchTextChars, 256);
        const fullText = call(nativeStringTrim, textRead.value, []) as string;
        const text = call(nativeStringSlice, fullText, [0, maxTextChars]) as string;
        const lowerHref = call(nativeStringLower, href, []) as string;
        const lowerText = call(nativeStringLower, fullText, []) as string;
        const matched =
          (call(nativeStringIndexOf, lowerHref, ["privacy"]) as number) >= 0 ||
          (call(nativeStringIndexOf, lowerText, ["privacy"]) as number) >= 0;
        if (!matched) {
          // Only an unmatched link whose text was cut at the MATCH budget can
          // still be hiding the word past the cut.
          if (textRead.truncated) truncated = true;
          continue;
        }
        const link = record();
        set(link, "href", href);
        set(link, "text", text);
        push(links, link);
        if (links.length >= maxCandidates) {
          if (index + 1 < length) truncated = true;
          break;
        }
      }
      const output = record();
      set(output, "links", links);
      set(output, "truncated", truncated);
      return stringify(output);
    } catch {
      return failWire("links");
    }
  });

  set(api, "fieldType", (element: unknown): string => {
    try {
      const tagName = call(elementTagNameGetter, element, []);
      if (tagName === "TEXTAREA") return "textarea";
      if (call(contentEditableGetter, element, []) === true) return "contenteditable";
      const attribute = call(elementGetAttribute, element, ["type"]);
      const raw = call(nativeStringLower, typeof attribute === "string" && attribute ? attribute : "text", []) as string;
      switch (raw) {
        case "date": case "datetime-local": case "email": case "month": case "number":
        case "password": case "search": case "tel": case "text": case "time": case "url": case "week":
          return raw;
        default:
          return "other";
      }
    } catch {
      return "other";
    }
  });

  set(api, "blur", (element: unknown): boolean => {
    try {
      call(blurMethod, element, []);
      return true;
    } catch {
      return false;
    }
  });

  set(api, "text", (maxCharsInput: unknown): string => {
    try {
      const maxChars = boundedPositiveInteger(maxCharsInput, 400_000);
      if (!maxChars) return failWire("text");
      const documentValue = call(windowDocumentGetter, globalThis, []);
      const body = call(documentBodyGetter, documentValue, []);
      if (!body) return failWire("text");
      const text = boundedNodeText(body as object, maxChars, 20_000);
      const output = record();
      set(output, "value", text.value);
      set(output, "truncated", text.truncated);
      return stringify(output);
    } catch {
      return failWire("text");
    }
  });

  nativeFreeze(api);
  try {
    nativeDefine(globalThis, key, {
      value: api,
      enumerable: false,
      configurable: false,
      writable: false
    });
  } catch {
    // A random-name collision or hostile earlier init script leaves no trusted
    // collector. Host callers treat absence as capture loss and fail closed.
  }
}

export type BoundedCollectorEvaluateLike = {
  evaluate<T, Arg>(pageFunction: (arg: Arg) => T, arg: Arg): Promise<T>;
};

export async function callBoundedPageCollector(
  page: BoundedCollectorEvaluateLike,
  key: string,
  method: "title" | "storage" | "links" | "text",
  input: unknown
): Promise<string | null> {
  return page.evaluate((arg) => {
    const api = (globalThis as Record<string, unknown>)[arg.key] as Record<string, unknown> | undefined;
    const collector = api?.[arg.method];
    if (typeof collector !== "function") return null;
    const result = collector(inputForCollector(arg));
    return typeof result === "string" ? result : null;
    function inputForCollector(value: { key: string; method: string; input: unknown }): unknown {
      return value.input;
    }
  }, { key, method, input });
}

export async function callBoundedElementCollector(
  handle: { evaluate<T, Arg>(pageFunction: (element: Element, arg: Arg) => T, arg: Arg): Promise<T> },
  key: string,
  method: "fieldType" | "blur"
): Promise<unknown> {
  return handle.evaluate((element, arg) => {
    const api = (globalThis as Record<string, unknown>)[arg.key] as Record<string, unknown> | undefined;
    const collector = api?.[arg.method];
    return typeof collector === "function" ? collector(element) : null;
  }, { key, method });
}
