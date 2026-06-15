export function baseSymbol(symbol: string) {
  return symbol.toUpperCase().split('_')[0];
}

export function symbolAliases(symbol: string) {
  const upper = symbol.toUpperCase();
  const base = baseSymbol(upper);
  const brokerBase = upper.replace(/_(US|CA|GB|UK|EU|DE|FR|NL|ES|IT|CH|SE|NO|DK|FI|IE|PT|AT|BE|PL|CZ|HU|RO|BG|GR|TR|HK|JP|AU|SG|ZA)_EQ$/, '');
  const simpleBase = baseSymbol(brokerBase);
  return new Set([
    upper,
    base,
    brokerBase,
    simpleBase,
    upper.replace('.', '-'),
    base.replace('.', '-'),
    brokerBase.replace('.', '-'),
    simpleBase.replace('.', '-'),
    upper.replace('-', '.'),
    base.replace('-', '.'),
    brokerBase.replace('-', '.'),
    simpleBase.replace('-', '.'),
  ]);
}

export function symbolsMatch(a: string, b: string) {
  const aliases = symbolAliases(a);
  for (const alias of symbolAliases(b)) {
    if (aliases.has(alias)) return true;
  }
  return false;
}
