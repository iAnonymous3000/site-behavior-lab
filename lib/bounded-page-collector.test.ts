import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import {
  callBoundedElementCollector,
  createBoundedPageCollectorKey,
  installBoundedPageCollector
} from "./bounded-page-collector";
import {
  collectBoundedPageTitle,
  collectStorageEntriesWithCoverage,
  MAX_CAPTURED_STORAGE_RECORDS
} from "./scan-runtime";
import { collectPrivacyPolicyLinks } from "./scanner";

test("pre-page native collector survives hostile DOM getters and prototype poisoning", async () => {
  const key = createBoundedPageCollectorKey();
  const realm = hostileDomRealm();
  realm.run(`(${installBoundedPageCollector.toString()})(${JSON.stringify(key)})`);
  realm.run(`globalThis[${JSON.stringify(key)}] = { title() { return "forged"; } };`);
  realm.run(POISON_PAGE_REALM);

  assert.deepEqual(await collectBoundedPageTitle(realm.page, key), {
    value: "Safe title",
    truncated: false
  });
  realm.run(`__setTitle("x".repeat(1000000))`);
  assert.deepEqual(await collectBoundedPageTitle(realm.page, key), {
    value: "",
    truncated: true
  });

  const storage = await collectStorageEntriesWithCoverage(realm.page, key);
  assert.equal(storage.records.length, MAX_CAPTURED_STORAGE_RECORDS);
  assert.equal(storage.omittedCount, 5);
  assert.equal(storage.truncated, true);
  assert.deepEqual(storage.records[0], {
    area: "localStorage",
    key: "key-0",
    valueBytes: 3
  });

  const links = await collectPrivacyPolicyLinks(
    realm.page as unknown as Parameters<typeof collectPrivacyPolicyLinks>[0],
    key
  );
  assert.deepEqual(links.links, [{ href: "https://example.com/privacy", text: "Privacy policy" }]);
  assert.equal(links.truncated, true);

  assert.equal(await callBoundedElementCollector(realm.element, key, "fieldType"), "email");
  assert.equal(await callBoundedElementCollector(realm.element, key, "blur"), true);
  assert.equal(realm.run("__wasBlurred()"), true);
});

test("an absent or forged collector capability fails closed", async () => {
  const realm = hostileDomRealm();
  const result = await collectBoundedPageTitle(realm.page, createBoundedPageCollectorKey());
  assert.deepEqual(result, { value: "", truncated: true });
});

test("the browser producer installs the immutable collector before creating the measured page", async () => {
  const scanner = await readFile(path.join(process.cwd(), "lib/scanner.ts"), "utf8");

  assert.match(scanner, /context\.addInitScript\(installBoundedPageCollector, boundedPageCollectorKey\)[\s\S]*context\.newPage\(\)/);
  assert.match(scanner, /callBoundedElementCollector\([\s\S]*"fieldType"/);
});

function hostileDomRealm(): {
  page: { evaluate<T, Arg>(pageFunction: (arg: Arg) => T, arg: Arg): Promise<T> };
  element: { evaluate<T, Arg>(pageFunction: (element: Element, arg: Arg) => T, arg: Arg): Promise<T> };
  run(source: string): unknown;
} {
  const context = vm.createContext({});
  vm.runInContext(REALM_SETUP, context);
  return {
    page: {
      async evaluate<T, Arg>(pageFunction: (arg: Arg) => T, arg: Arg): Promise<T> {
        (context as Record<string, unknown>).__arg = arg;
        return vm.runInContext(`(${pageFunction.toString()})(__arg)`, context) as T;
      }
    },
    element: {
      async evaluate<T, Arg>(
        pageFunction: (element: Element, arg: Arg) => T,
        arg: Arg
      ): Promise<T> {
        (context as Record<string, unknown>).__arg = arg;
        return vm.runInContext(`(${pageFunction.toString()})(__field, __arg)`, context) as T;
      }
    },
    run(source: string): unknown {
      return vm.runInContext(source, context);
    }
  };
}

const REALM_SETUP = String.raw`
  const nodeState = new WeakMap();
  const elementState = new WeakMap();
  const htmlState = new WeakMap();
  const anchorState = new WeakMap();
  const documentState = new WeakMap();
  const collectionState = new WeakMap();
  const storageState = new WeakMap();

  class Node {
    constructor(type = 1, value = null) {
      nodeState.set(this, { type, value, parent: null, children: [] });
    }
    get firstChild() { return nodeState.get(this).children[0] ?? null; }
    get nextSibling() {
      const state = nodeState.get(this);
      if (!state.parent) return null;
      const siblings = nodeState.get(state.parent).children;
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    get parentNode() { return nodeState.get(this).parent; }
    get nodeType() { return nodeState.get(this).type; }
    get nodeValue() { return nodeState.get(this).value; }
    append(child) {
      nodeState.get(child).parent = this;
      const children = nodeState.get(this).children;
      children[children.length] = child;
    }
  }
  class Element extends Node {
    constructor(tagName) {
      super(1, null);
      elementState.set(this, { tagName, attributes: Object.create(null) });
    }
    get tagName() { return elementState.get(this).tagName; }
    getAttribute(name) { return elementState.get(this).attributes[name] ?? null; }
    setAttribute(name, value) { elementState.get(this).attributes[name] = value; }
  }
  class HTMLElement extends Element {
    constructor(tagName) {
      super(tagName);
      htmlState.set(this, { editable: false, blurred: false });
    }
    get isContentEditable() { return htmlState.get(this).editable; }
    blur() { htmlState.get(this).blurred = true; }
  }
  class HTMLAnchorElement extends HTMLElement {
    constructor(href, text) {
      super("A");
      anchorState.set(this, { href });
      this.append(new Node(3, text));
    }
    get href() { return anchorState.get(this).href; }
  }
  class HTMLCollection {
    constructor(values) { collectionState.set(this, values); }
    get length() { return collectionState.get(this).length; }
    item(index) { return collectionState.get(this)[index] ?? null; }
  }
  class Storage {
    constructor(entries) { storageState.set(this, entries); }
    get length() { return storageState.get(this).length; }
    key(index) { return storageState.get(this)[index]?.[0] ?? null; }
    getItem(key) {
      const entries = storageState.get(this);
      for (let index = 0; index < entries.length; index += 1) {
        if (entries[index][0] === key) return entries[index][1];
      }
      return null;
    }
  }
  class Document {
    constructor(title, links, body) { documentState.set(this, { title, links, body }); }
    get title() { return documentState.get(this).title; }
    get links() { return documentState.get(this).links; }
    get body() { return documentState.get(this).body; }
  }

  const anchors = new Array(2002);
  anchors[0] = new HTMLAnchorElement("https://example.com/privacy", "Privacy policy");
  for (let index = 1; index < anchors.length; index += 1) {
    anchors[index] = new HTMLAnchorElement("https://example.com/page-" + index, "ordinary");
  }
  const body = new HTMLElement("BODY");
  body.append(new Node(3, "Policy body"));
  const documentValue = new Document("Safe title", new HTMLCollection(anchors), body);
  const entries = new Array(1005);
  entries[0] = ["key-0", "€"];
  for (let index = 1; index < entries.length; index += 1) entries[index] = ["key-" + index, "v"];
  const localValue = new Storage(entries);
  const sessionValue = new Storage([]);
  const __field = new HTMLElement("INPUT");
  __field.setAttribute("type", "EMAIL");

  Object.defineProperty(globalThis, "document", { configurable: true, get() { return documentValue; } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { return localValue; } });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { return sessionValue; } });
  globalThis.__setTitle = (value) => { documentState.get(documentValue).title = value; };
  globalThis.__wasBlurred = () => htmlState.get(__field).blurred;
`;

const POISON_PAGE_REALM = String.raw`
  const poisonedGetter = { configurable: true, get() { throw new Error("page getter invoked"); } };
  Object.defineProperty(globalThis, "document", poisonedGetter);
  Object.defineProperty(globalThis, "localStorage", poisonedGetter);
  Object.defineProperty(globalThis, "sessionStorage", poisonedGetter);
  Object.defineProperty(documentValue, "title", poisonedGetter);
  Object.defineProperty(anchors[0], "href", poisonedGetter);
  Object.defineProperty(__field, "tagName", poisonedGetter);
  __field.getAttribute = __field.blur = function () { throw new Error("page own method invoked"); };
  localValue.key = localValue.getItem = function () { throw new Error("page own method invoked"); };
  for (const [prototype, name] of [
    [Document.prototype, "title"], [Document.prototype, "links"], [Document.prototype, "body"],
    [Storage.prototype, "length"], [HTMLCollection.prototype, "length"],
    [HTMLAnchorElement.prototype, "href"], [Node.prototype, "firstChild"],
    [Node.prototype, "nextSibling"], [Node.prototype, "parentNode"],
    [Node.prototype, "nodeType"], [Node.prototype, "nodeValue"],
    [Element.prototype, "tagName"], [HTMLElement.prototype, "isContentEditable"]
  ]) Object.defineProperty(prototype, name, poisonedGetter);
  Storage.prototype.key = Storage.prototype.getItem = function () { throw new Error("page method invoked"); };
  HTMLCollection.prototype.item = function () { throw new Error("page method invoked"); };
  Element.prototype.getAttribute = function () { throw new Error("page method invoked"); };
  HTMLElement.prototype.blur = function () { throw new Error("page method invoked"); };
  Array.prototype.push = function () { throw new Error("page intrinsic invoked"); };
  String.prototype.slice = String.prototype.trim = String.prototype.toLowerCase =
    String.prototype.includes = String.prototype.indexOf = String.prototype.charCodeAt =
      function () { throw new Error("page intrinsic invoked"); };
  RegExp.prototype.test = function () { throw new Error("page intrinsic invoked"); };
  globalThis.Blob = function () { throw new Error("page Blob invoked"); };
  Reflect.apply = function () { throw new Error("page Reflect.apply invoked"); };
  JSON.stringify = function () { throw new Error("page JSON.stringify invoked"); };
`;
