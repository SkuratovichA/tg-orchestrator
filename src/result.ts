// The owner's own tryCatch helper, copied verbatim from
// former/src/utils/try-catch.ts so the two stay spellable the same way.
// A tuple, not an exception: `const [value, err] = await tryCatch(p)` forces
// the caller to look at the error on the same line it got the value.
export async function tryCatch<T, E = Error>(promise: T | Promise<T>) {
  try {
    const data = await promise;
    return [data, null] as const;
  } catch (error) {
    return [null, error as E] as const;
  }
}
