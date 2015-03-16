import options = require("./../common/options");
import iOSProxyServices = require("./../common/mobile/ios/ios-proxy-services");
import iOSDevice = require("./../common/mobile/ios/ios-device");
import net = require("net");
import path = require("path");

module notification {
	export function waitForDebug(bundleId: string): string {
		return bundleId + ":NativeScript.Debug.WaitForDebugger";
	}

	export function attachRequest(bundleId: string): string {
		return bundleId + ":NativeScript.Debug.AttachRequest";
	}

	export function appLaunching(bundleId: string): string {
		return bundleId + ":NativeScript.Debug.AppLaunching";
	}

	export function readyForAttach(bundleId: string): string {
		return bundleId + ":NativeScript.Debug.ReadyForAttach";
	}
}

class IOSDebugService implements IDebugService {
	constructor(private $platformService: IPlatformService,
		private $iOSEmulatorServices: Mobile.IEmulatorPlatformServices,
		private $devicesServices: Mobile.IDevicesServices,
		private $platformsData: IPlatformsData,
		private $projectData: IProjectData,
		private $childProcess: IChildProcess,
		private $logger: ILogger,
		private $fs: IFileSystem,
		private $errors: IErrors,
		private $injector: IInjector,
		private $npm: INodePackageManager) {
	}

	get platform(): string {
		return "ios";
	}

	public debug(): IFuture<void> {
		return (() => {
			if ((!options.debugBrk && !options.start) || (options.debugBrk && options.start)) {
				this.$logger.error("Expected exactly one of the --debug-brk or --start options.");
				return;
			}

			if (options.emulator) {
				if (options.debugBrk) {
					this.emulatorDebugBrk();
				} else if (options.start) {
					this.emulatorStart();
				}
			} else {
				if (options.debugBrk) {
					this.deviceDebugBrk();
				} else if (options.start) {
					this.deviceStart();
				}
			}
		}).future<void>()();
	}

	private emulatorDebugBrk(): void {
		var emulatorDebugging = new iOSXcrunSimctl(this.$childProcess);
		var device = emulatorDebugging.getRunningEmulator().wait();
		if (device) {
			this.$logger.info("Install and run on: " + device.uuid);
		} else {
			this.$logger.error("This command expects a running emulator.");
			return;
		}

		var platformData = this.$platformsData.getPlatformData(this.platform);
		this.$platformService.buildPlatform(this.platform).wait();
		var emulatorPackage = this.$platformService.getLatestApplicationPackageForEmulator(platformData).wait();

		device.installApp(emulatorPackage.packageName).wait();

		this.executeOpenDebuggerClient().wait();

		device.launchApp(this.$projectData.projectId, "--nativescript-debug-brk").wait();
	}

	private emulatorStart() {
		this.executeOpenDebuggerClient().wait();

		var emulatorDebugging = new iOSXcrunSimctl(this.$childProcess);

		var device = emulatorDebugging.getRunningEmulator().wait();
		if (!device) {
			this.$logger.error("This command expects a running emulator.");
		}

		var projectId = this.$projectData.projectId;
		var attachRequestMessage = notification.attachRequest(projectId);
		device.postNotification(attachRequestMessage).wait();
	}

	private deviceDebugBrk() {
		this.$devicesServices.initialize({ platform: this.platform, deviceId: options.device }).wait();

		this.$devicesServices.execute(device => (() => {
			this.$platformService.deployOnDevice(this.platform).wait();
			var deviceDebugging = new IOSDeviceDebugging(this.$projectData.projectId, <iOSDevice.IOSDevice>device, this.$logger, this.$injector);
			deviceDebugging.debugApplicationOnStart();
			this.executeOpenDebuggerClient().wait();
			device.runApplication(this.$projectData.projectId).wait();
		}).future<void>()()).wait();
	}

	private deviceStart() {
		this.$devicesServices.initialize({ platform: this.platform, deviceId: options.device }).wait();

		this.$devicesServices.execute(device => (() => {
			this.executeOpenDebuggerClient().wait();
			var deviceDebugging = new IOSDeviceDebugging(this.$projectData.projectId, <iOSDevice.IOSDevice>device, this.$logger, this.$injector);
			deviceDebugging.debugRunningApplication();
		}).future<void>()()).wait();
	}

	public executeOpenDebuggerClient(): IFuture<void> {
		if (options.client === false) {
			return (() => {
				this.$logger.info("Supressing debugging client.");
			}).future<void>()();
		} else {
			return this.openDebuggingClient();
		}
	}

	private openDebuggingClient(): IFuture<void> {
		return (() => {
			var cmd = "open -a Safari " + this.getSafariPath();
			this.$childProcess.exec(cmd).wait();
		}).future<void>()();
	}

	private getSafariPath(): string {
		var tnsIosPackage = "";
		if (options.frameworkPath) {
			if (this.$fs.getFsStats(options.frameworkPath).wait().isFile()) {
				this.$errors.fail("frameworkPath option must be path to directory which contains tns-ios framework");
			}

			tnsIosPackage = path.resolve(options.frameworkPath);
		} else {
			tnsIosPackage = this.$npm.install("tns-ios").wait();
		}

		var safariPath = path.join(tnsIosPackage, "WebInspectorUI/Safari/Main.html");

		return safariPath;
	}
}
$injector.register("iOSDebugService", IOSDebugService);

class iOSXcrunSimctlDevice {
	constructor(private deviceUUID: string,
		private $childProcess: IChildProcess) { }

	public get uuid(): string { return this.deviceUUID; }

	public postNotification(notification: string): IFuture<void> {
		return this.$childProcess.exec("xcrun simctl notify_post " + this.uuid + " " + notification);
	}

	public installApp(appPackage: string): IFuture<void> {
		return this.$childProcess.exec("xcrun simctl install " + this.uuid + " " + appPackage);
	}

	public launchApp(appId: string, args?: string): IFuture<void> {
		var cmd = "xcrun simctl launch " + this.uuid + " " + appId;
		if (args) {
			cmd = cmd + " " + args;
		}
		console.log("cmd: " + cmd);

		return this.$childProcess.exec(cmd, { stdio: "inherit" });
	}
}

class iOSXcrunSimctl {
	constructor(private $childProcess: IChildProcess) { }

	public getRunningEmulator(): IFuture<iOSXcrunSimctlDevice> {
		return (() => {
			var runningEmulators: string = this.$childProcess.exec("xcrun simctl list | grep Booted | cut -d \"(\" -f2 | cut -d \")\" -f1").wait();
			var runningEmulator = runningEmulators.split("\n")[0];

			if (runningEmulator) {
				return new iOSXcrunSimctlDevice(runningEmulator, this.$childProcess);
			} else {
				return null;
			}
		}).future<iOSXcrunSimctlDevice>()();
	}
}

class IOSDeviceDebugging {
	private $notificationProxyClient: iOSProxyServices.NotificationProxyClient;

	constructor(private bundleId: string,
		private $iOSDevice: iOSDevice.IOSDevice,
		private $logger: ILogger,
		private $injector: IInjector) {

		this.$notificationProxyClient = this.$injector.resolve(iOSProxyServices.NotificationProxyClient, { device: this.$iOSDevice })
	}

	public debugApplicationOnStart() {
		var appLaunchMessage = notification.appLaunching(this.bundleId);
		this.$notificationProxyClient.addObserver(appLaunchMessage, () => {
			this.$logger.info("Got AppLaunching");
			this.proxyDebuggingTrafic();
			var waitForDebuggerMessage = notification.waitForDebug(this.bundleId);
			this.$notificationProxyClient.postNotification(waitForDebuggerMessage);
		});
	}

	public debugRunningApplication() {
		this.proxyDebuggingTrafic();
		var attachRequestMessage = notification.attachRequest(this.bundleId);
		this.$notificationProxyClient.postNotification(attachRequestMessage);
	}

	private proxyDebuggingTrafic(): void {

		var identifier = this.$iOSDevice.getIdentifier();
		this.$logger.info("Device Identifier: " + identifier);

		var readyForAttachMessage = notification.readyForAttach(this.bundleId);
		this.$notificationProxyClient.addObserver(readyForAttachMessage, () => {
			this.$logger.info("Got ReadyForAttach");

			// NOTE: We will try to provide command line options to select ports, at least on the localhost.
			var devicePort = 8080;
			var localPort = 8080;

			this.printHowToTerminate();

			var localServer = net.createServer((localSocket) => {
				// localServer.close();

				this.$logger.info("Front-end client connected to localhost " + localPort);

				var deviceSocket: any;

				var buff = new Array();
				localSocket.on('data', (data: NodeBuffer) => {
					if (deviceSocket) {
						deviceSocket.write(data);
					} else {
						buff.push(data);
					}
				});
				localSocket.on('end', () => {
					this.$logger.info('Localhost client disconnected!');
					process.exit(0);
				});

				deviceSocket = this.$iOSDevice.connectToPort(devicePort);
				this.$logger.info("Connected localhost " + localPort + " to device " + devicePort);

				buff.forEach((data) => {
					deviceSocket.write(data);
				});

				deviceSocket.on('data', (data: NodeBuffer) => {
					localSocket.write(data);
				});

				deviceSocket.on('end', () => {
					this.$logger.info("Device socket closed!");
					process.exit(0);
				});
			});

			localServer.listen(localPort, () => {
				this.$logger.info("Opened localhost " + localPort);
			});
		});
	}

	private printHowToTerminate() {
		this.$logger.info("\nSetting up debugger proxy...\n\nPress Ctrl + C to terminate, or disconnect.\n");
	}
}
