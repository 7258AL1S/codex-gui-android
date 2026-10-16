package reva.local;

import java.io.File;

/**
 * Minimal native launcher for ReVa's headless MCP server.
 *
 * The official CLI (`mcp-reva`) starts the very same Java class through PyGhidra/JPype.
 * On Termux we start it directly with Ghidra's own launcher (`support/launch.sh`), which
 * avoids needing PyGhidra (jpype1) built for the local Python.
 *
 * Usage: RevaServerMain <config.properties> <projectDir> <projectName>
 */
public class RevaServerMain {

	public static void main(String[] args) throws Exception {
		File configFile = args.length > 0 ? new File(args[0]) : null;
		File projectDir = args.length > 1 ? new File(args[1])
				: new File(System.getProperty("user.home"), ".reva/projects");
		String projectName = args.length > 2 ? args[2] : "reva";

		projectDir.mkdirs();

		System.out.println("REVA_START config=" + configFile + " projectDir=" + projectDir
				+ " project=" + projectName);
		System.out.flush();

		reva.headless.RevaHeadlessLauncher launcher = new reva.headless.RevaHeadlessLauncher(
				configFile,
				true,   // autoInitializeGhidra
				false,  // useRandomPort -> take the port from the config file
				projectDir,
				projectName,
				null);  // apiKey (local loopback only)

		launcher.start();

		if (!launcher.isRunning()) {
			System.err.println("REVA_ERROR server did not report running state");
			System.exit(3);
		}

		System.out.println("REVA_READY port=" + launcher.getPort());
		System.out.flush();

		Runtime.getRuntime().addShutdownHook(new Thread(() -> {
			System.out.println("REVA_STOP");
			launcher.stop();
		}));

		Thread.currentThread().join();
	}
}
