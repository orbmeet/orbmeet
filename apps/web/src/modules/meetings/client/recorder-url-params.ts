export function parseRecorderHashParams(
  hashValue: string,
  searchValue = "",
): URLSearchParams {
  const params = new URLSearchParams(
    searchValue.startsWith("?") ? searchValue.slice(1) : searchValue,
  );
  const hash = hashValue.startsWith("#") ? hashValue.slice(1) : hashValue;
  const questionIndex = hash.indexOf("?");
  const normalized =
    questionIndex === -1
      ? hash
      : `${hash.slice(0, questionIndex)}&${hash.slice(questionIndex + 1)}`;
  const hashParams = new URLSearchParams(normalized);
  hashParams.forEach((value, key) => params.set(key, value));
  return params;
}
