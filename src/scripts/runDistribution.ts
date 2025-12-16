import { distributionController } from "../services/distributionController";

const main = async () => {
  const status = await distributionController.start();
  if (!status.mint) {
    console.warn("Distribution loop did not start: mint is missing.");
  } else if (status.running) {
    console.log(
      `Distribution loop running for mint ${status.mint} (paused=${status.paused})`
    );
  }

  await distributionController.waitForCompletion();
};

main().catch((err) => {
  console.error("Distribution loop failed", err);
  process.exit(1);
});
