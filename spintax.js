// Spintax for bulk messages: "{Hi|Hello|Hey} {name}, ..." produces a
// different random variation per recipient, so mass sends don't look like
// identical spam. {name} is replaced with the contact's first name.

export function spin(template, contact) {
  let text = String(template || "");

  const rawName = contact && contact.name ? String(contact.name).trim() : "";
  const firstName = rawName.split(/\s+/)[0] || "";
  text = text.replace(/\{name\}/gi, firstName);

  text = text.replace(/\{([^{}]+)\}/g, (match, inner) => {
    const options = inner
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (options.length === 0) return match;
    return options[Math.floor(Math.random() * options.length)];
  });

  // Tidy double spaces left behind by an empty {name}.
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hasSpintax(template) {
  return /\{([^{}]+)\}/.test(String(template || ""));
}
