

  const owner =
    await arb.owner();

  console.log(
    `\n👤 OWNER:\n${owner}`
  );

  console.log(
    `\n👤 WALLET:\n${wallet.address}`
  );

  let taskIndex = 0;

  async function worker() {

    while (true) {

      try {

        const task =
          scanTasks[
            taskIndex++
            % scanTasks.length
          ];

        const signal =
          await runDepthAnalysis(

            task.name,
            task.token
          );

        if (!signal) {

          await sleep(
            LOOP_DELAY
          );

          continue;
        }

        console.log(
          "\n🏆 BEST SIGNAL"
        );

        console.log(
          `\nTOKEN:\n${task.name}`
