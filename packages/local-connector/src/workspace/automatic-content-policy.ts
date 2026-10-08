// These are the legacy alternatives excluding JWT, whose token inspection advances below.
const otherSecretPattern =
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH)|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b|\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|authorization|credential)\s*[=:]\s*["']?[^\s"']{8,}/i;
function word(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}
function jwtMaterial(text: string): boolean {
  let index = 0,
    headerBefore = false,
    payloadAfterHeader = false;
  while (index < text.length) {
    let firstHeader = -1,
      hasWord = false;
    const start = index;
    // Each maximal base64url segment is consumed once, even with many '-eyJ' prefixes.
    while (index < text.length) {
      const code = text.charCodeAt(index);
      const isWord = word(code);
      if (!isWord && code !== 45) break;
      hasWord ||= isWord;
      if (
        firstHeader === -1 &&
        !word(text.charCodeAt(index - 1)) &&
        (code === 69 || code === 101) &&
        (text[index + 1] === "y" || text[index + 1] === "Y") &&
        (text[index + 2] === "j" || text[index + 2] === "J")
      )
        firstHeader = index;
      index++;
    }
    // Any word character gives a trailing word boundary: at a hyphen or the segment end.
    // An all-hyphen signature has no such boundary. The payload only needs to be nonempty.
    if (payloadAfterHeader && hasWord) return true;
    if (index > start && text[index] === ".") {
      payloadAfterHeader = headerBefore;
      headerBefore = firstHeader !== -1 && index - firstHeader >= 15;
      index++;
    } else {
      headerBefore = false;
      payloadAfterHeader = false;
      if (index === start) index++;
    }
  }
  return false;
}

const sensitiveKeys = new Set([
  "password",
  "passwd",
  "apikey",
  "api-key",
  "api_key",
  "accesstoken",
  "access-token",
  "access_token",
  "clientsecret",
  "client-secret",
  "client_secret",
  "authorization",
  "credential",
  "credentials",
]);
const sensitivePrefixes = new Set(
  [...sensitiveKeys].flatMap((key) =>
    Array.from({ length: key.length }, (_, index) => key.slice(0, index + 1)),
  ),
);
const escapeCharacters: Readonly<Record<string, string>> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "0": "\0",
};
const whitespace = (value: string | undefined) => value !== undefined && /\s/u.test(value);
function hexDigit(value: string | undefined) {
  if (value === undefined) return -1;
  const code = value.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}
function escape(text: string, index: number): { value: string; next: number } {
  const marker = text[index + 1];
  if (marker === undefined) return { value: "\\", next: text.length };
  if (marker === "\n") return { value: "", next: index + 2 };
  if (marker === "\r" && text[index + 2] === "\n") return { value: "", next: index + 3 };
  if (marker === "u" && text[index + 2] === "{") {
    let next = index + 3,
      value = 0;
    while (hexDigit(text[next]) !== -1) {
      value = Math.min(0x110000, value * 16 + hexDigit(text[next]));
      next++;
    }
    if (next > index + 3 && text[next] === "}")
      return { value: value <= 0x10ffff ? String.fromCodePoint(value) : "\uFFFD", next: next + 1 };
  }
  const count = marker === "u" ? 4 : marker === "x" ? 2 : marker === "U" ? 8 : 0;
  if (count) {
    let value = 0,
      valid = true;
    for (let part = 0; part < count; part++) {
      const digit = hexDigit(text[index + 2 + part]);
      if (digit === -1) {
        valid = false;
        break;
      }
      value = value * 16 + digit;
    }
    if (valid)
      return {
        value: value <= 0x10ffff ? String.fromCodePoint(value) : "\uFFFD",
        next: index + 2 + count,
      };
  }
  return { value: escapeCharacters[marker] ?? marker, next: index + 2 };
}
// Candidates stop on the first decoded character outside the finite sensitive-key prefix set.
// No candidate retries an arbitrarily long quoted suffix at the next escaped quote.
function sensitiveKeyEnd(text: string, start: number, yaml: boolean): number | null {
  const quote = text[start];
  let index = start + 1,
    decoded = "";
  while (index < text.length) {
    let value: string;
    if (text[index] === quote) {
      if (yaml && quote === "'" && text[index + 1] === "'") {
        value = "'";
        index += 2;
      } else return sensitiveKeys.has(decoded) ? index + 1 : null;
    } else if (text[index] === "\\" && !(yaml && quote === "'")) {
      const result = escape(text, index);
      value = result.value;
      index = result.next;
    } else {
      value = text[index];
      index++;
    }
    decoded += value.toLowerCase();
    if (decoded !== "" && !sensitivePrefixes.has(decoded)) return null;
  }
  return null;
}
function literal(text: string, start: number, yaml: boolean) {
  const quote = text[start];
  let index = start + 1,
    nonempty = false,
    interpolated = false;
  while (index < text.length) {
    if (text[index] === quote) {
      if (yaml && quote === "'" && text[index + 1] === "'") {
        nonempty = true;
        index += 2;
        continue;
      }
      return { end: index + 1, closed: true, nonempty, interpolated };
    }
    if (text[index] === "\\" && !(yaml && quote === "'")) {
      const result = escape(text, index);
      nonempty ||= result.value.length > 0;
      index = result.next;
      continue;
    }
    if (quote === "`" && text[index] === "$" && text[index + 1] === "{") interpolated = true;
    nonempty = true;
    index++;
  }
  return { end: index, closed: false, nonempty, interpolated };
}
const digit = (value: string | undefined) => value !== undefined && value >= "0" && value <= "9";
function numericLiteralEnd(text: string, start: number): number | null {
  let index = start;
  if (text[index] === "-") index++;
  if (!digit(text[index])) return null;
  while (digit(text[index])) index++;
  if (text[index] === ".") {
    index++;
    if (!digit(text[index])) return null;
    while (digit(text[index])) index++;
  }
  if (text[index] === "e" || text[index] === "E") {
    index++;
    if (text[index] === "+" || text[index] === "-") index++;
    if (!digit(text[index])) return null;
    while (digit(text[index])) index++;
  }
  return index === text.length || whitespace(text[index]) || ",;}".includes(text[index])
    ? index
    : null;
}

// Pure inspection: no I/O, evaluation, clock access, or externally visible initialization changes.
// The outer cursor only advances; literal/bare-value scans consume their region once.
export function automaticSecretMaterial(text: string, path: string): boolean {
  if (otherSecretPattern.test(text) || jwtMaterial(text)) return true;
  const yaml = /\.ya?ml$/i.test(path);
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"' && text[index] !== "'") {
      index++;
      continue;
    }
    const keyEnd = sensitiveKeyEnd(text, index, yaml);
    if (keyEnd === null) {
      index++;
      continue;
    }
    index = keyEnd;
    while (whitespace(text[index])) index++;
    const delimiter = text[index];
    if (delimiter !== ":" && delimiter !== "=") continue;
    index++;
    while (whitespace(text[index])) index++;
    if (text[index] === '"' || text[index] === "'" || text[index] === "`") {
      const value = literal(text, index, yaml);
      index = value.end;
      if (value.closed && value.nonempty && !value.interpolated) return true;
      continue;
    }
    if (yaml && delimiter === ":") {
      const start = index;
      while (index < text.length && !whitespace(text[index]) && !"\"'`#".includes(text[index]))
        index++;
      const size = index - start;
      if (
        size > 0 &&
        !(size === 1 && text[start] === "~") &&
        !(size === 4 && text.slice(start, index).toLowerCase() === "null")
      )
        return true;
    } else if (numericLiteralEnd(text, index) !== null) return true;
  }
  return false;
}
