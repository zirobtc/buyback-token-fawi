import { refreshTokenHolders } from "../services/holders";

const main = async () => {
  const tokensFromArgs = process.argv.slice(2).filter(Boolean);
  const result = await refreshTokenHolders({
    tokens: tokensFromArgs.length > 0 ? tokensFromArgs : undefined
  });

  console.log(
    JSON.stringify(
      {
        filePath: result.filePath,
        tokensPlanned: result.tokensPlanned,
        refreshed: result.refreshed
      },
      null,
      2
    )
  );
};

main().catch((err) => {
  console.error("fetchTopHolders failed", err);
  process.exit(1);
});
