// Copy only the allowed keys the object actually has, so missing fields stay missing.
export const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((key) => Object.hasOwn(obj, key)).map((key) => [key, obj[key]]));
