export async function runCli(argv, deps) {
  const {
    rawColorArg,
    applyColorPreference,
    printStableUrlHelp,
    parseArgs,
    usage,
    runSetupWizard,
    runSettings,
    runExecuteHandoff,
    runWatchHandoff,
    runLoopHandoff,
    runHelperScript,
    installCloudflaredLocal,
    runDoctor,
    runStart
  } = deps;

  let currentArgv = [...argv];
  applyColorPreference({ color: rawColorArg(currentArgv) });
  let subcommand = currentArgv[0];

  if (subcommand === 'stable-help') {
    printStableUrlHelp();
    return;
  }
  if (subcommand === 'setup' || subcommand === 'onboard') {
    const setupDefaults = parseArgs(currentArgv.slice(1));
    applyColorPreference(setupDefaults);
    if (setupDefaults.help || currentArgv[1] === 'help') {
      usage();
      return;
    }
    const setupArgs = await runSetupWizard(currentArgv.slice(1));
    if (!setupArgs) return;
    currentArgv = setupArgs;
    subcommand = currentArgv[0];
  }
  if (subcommand === 'settings' || subcommand === 'config') {
    await runSettings(currentArgv.slice(1));
    return;
  }
  if (subcommand === 'execute-handoff' || subcommand === 'execute' || subcommand === 'run-handoff') {
    await runExecuteHandoff(currentArgv.slice(1));
    return;
  }
  if (subcommand === 'watch-handoff' || subcommand === 'watch') {
    await runWatchHandoff(currentArgv.slice(1));
    return;
  }
  if (subcommand === 'loop-handoff' || subcommand === 'loop') {
    await runLoopHandoff(currentArgv.slice(1));
    return;
  }
  if (subcommand === 'pro-bundle' || subcommand === 'bundle') {
    runHelperScript('pro-bundle.mjs', currentArgv.slice(1));
  }
  if (subcommand === 'pro-apply' || subcommand === 'apply') {
    runHelperScript('pro-apply.mjs', currentArgv.slice(1));
  }
  if (subcommand === 'install-cloudflared') {
    const installArgs = parseArgs(currentArgv.slice(1));
    applyColorPreference(installArgs);
    if (installArgs.help) {
      usage();
      return;
    }
    const installedCloudflared = await installCloudflaredLocal();
    console.log(`cloudflared ready: ${installedCloudflared}`);
    return;
  }
  if (subcommand === 'doctor') {
    await runDoctor(currentArgv.slice(1));
    return;
  }

  await runStart(currentArgv);
}
