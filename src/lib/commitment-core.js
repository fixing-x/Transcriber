(function exposeCommitment(globalScope) {
  function stablePairs(previous, current) {
    const before = previous?.words ?? [];
    const now = current?.words ?? [];
    const table = Array.from({ length: before.length + 1 }, () => new Uint16Array(now.length + 1));

    for (let i = 1; i <= before.length; i += 1) {
      for (let j = 1; j <= now.length; j += 1) {
        const timeClose = Math.abs(before[i - 1].start - now[j - 1].start) <= 1.8;
        if (before[i - 1].normalized === now[j - 1].normalized && timeClose) {
          table[i][j] = table[i - 1][j - 1] + 1;
        } else {
          table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
        }
      }
    }

    const pairs = [];
    let i = before.length;
    let j = now.length;
    while (i > 0 && j > 0) {
      const timeClose = Math.abs(before[i - 1].start - now[j - 1].start) <= 1.8;
      if (before[i - 1].normalized === now[j - 1].normalized && timeClose &&
        table[i][j] === table[i - 1][j - 1] + 1) {
        pairs.push([i - 1, j - 1]);
        i -= 1;
        j -= 1;
      } else if (table[i - 1][j] >= table[i][j - 1]) i -= 1;
      else j -= 1;
    }
    return pairs.reverse();
  }

  globalScope.ReadAlongCommitment = Object.freeze({ stablePairs });
})(globalThis);
