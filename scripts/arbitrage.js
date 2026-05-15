function generateHopRoutes(maxHops = 2) {
  const tokens = Object.keys(TOKENS);
  const routes = [];

  function build(route, depth) {
    if (depth === maxHops) {
      // Force final hop back to USDC
      routes.push([...route, "USDC"]);
      return;
    }

    for (const t of tokens) {
      if (t !== "USDC") {
        build([...route, t], depth + 1);
      }
    }
  }

  build([], 0);
  return routes;
}
