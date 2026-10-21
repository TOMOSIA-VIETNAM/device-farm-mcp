import fs from "node:fs";
import path from "node:path";

import {
	CreateRemoteAccessSessionCommand,
	CreateUploadCommand,
	Device,
	DeviceFarmClient,
	GetRemoteAccessSessionCommand,
	GetUploadCommand,
	InstallToRemoteAccessSessionCommand,
	ListDevicesCommand,
	RemoteAccessSession,
	StopRemoteAccessSessionCommand,
	UploadType,
} from "@aws-sdk/client-device-farm";

import { ActionableError } from "./robot";

// device farm only runs in us-west-2
const REGION = "us-west-2";
const SESSION_NAME = "device-farm-mcp";
const DEFAULT_ALLOCATE_TIMEOUT_SECONDS = 900;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

const SESSION_ARN_PREFIX = "arn:aws:devicefarm:";
const TERMINAL_SESSION_STATUSES = ["COMPLETED", "STOPPING"];

export type DeviceFarmPlatform = "android" | "ios";

export interface DeviceFarmAllocateOptions {
	platform: DeviceFarmPlatform;
	name?: string;
	version?: string[];
	wait?: boolean;
	timeoutSeconds?: number;
}

export interface DeviceFarmSession {
	arn: string;
	status: string;
	platform: DeviceFarmPlatform;
	deviceName?: string;
	osVersion?: string;
	endpoint?: string;
}

export const isDeviceFarmSessionArn = (deviceId: string): boolean => deviceId.startsWith(SESSION_ARN_PREFIX) && deviceId.includes(":session:");

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const compareVersions = (a: string, b: string): number => {
	const pa = a.split(".").map(n => parseInt(n, 10) || 0);
	const pb = b.split(".").map(n => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] || 0) - (pb[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
};

export const matchesVersion = (os: string, filter: string): boolean => {
	const match = filter.match(/^(>=|<=|>|<)?\s*(.+)$/);
	if (!match) {
		return false;
	}

	const [, operator, wanted] = match;
	const diff = compareVersions(os, wanted);
	switch (operator) {
		case ">=": return diff >= 0;
		case ">": return diff > 0;
		case "<=": return diff <= 0;
		case "<": return diff < 0;
		// an exact "18" matches "18.6.2"
		default: return os === wanted || os.startsWith(`${wanted}.`);
	}
};

export const matchesName = (deviceName: string, filter: string): boolean => {
	if (filter.endsWith("*")) {
		return deviceName.toLowerCase().startsWith(filter.slice(0, -1).toLowerCase());
	}

	return deviceName.toLowerCase() === filter.toLowerCase();
};

const toPlatform = (platform: string | undefined): DeviceFarmPlatform => platform === "IOS" ? "ios" : "android";

const toSession = (session: RemoteAccessSession): DeviceFarmSession => ({
	arn: session.arn!,
	status: session.status || "UNKNOWN",
	platform: toPlatform(session.device?.platform),
	deviceName: session.device?.name,
	osVersion: session.device?.os,
	endpoint: session.endpoints?.remoteDriverEndpoint,
});

export class DeviceFarm {

	private readonly client = new DeviceFarmClient({ region: REGION });

	private getProjectArn(): string {
		const projectArn = process.env.DEVICEFARM_PROJECT_ARN;
		if (!projectArn) {
			throw new ActionableError("DEVICEFARM_PROJECT_ARN is not set. Ask the user to set it to the ARN of their AWS Device Farm project and restart the server");
		}

		return projectArn;
	}

	private async send<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (err: any) {
			if (err instanceof ActionableError) {
				throw err;
			}

			// credential problems are something the user can fix, surface them as such
			if (err.name === "CredentialsProviderError" || err.name === "UnrecognizedClientException" || err.name === "ExpiredTokenException" || err.name === "AccessDeniedException") {
				throw new ActionableError(`AWS Device Farm rejected the request (${err.name}: ${err.message}). Ask the user to configure AWS credentials (environment variables, ~/.aws/credentials or "aws sso login") with Device Farm permissions`);
			}

			throw new ActionableError(`AWS Device Farm request failed (${err.name}: ${err.message})`);
		}
	}

	private async listRemoteAccessDevices(): Promise<Device[]> {
		const devices: Device[] = [];
		let nextToken: string | undefined;
		do {
			const response = await this.send(() => this.client.send(new ListDevicesCommand({ nextToken })));
			devices.push(...(response.devices || []));
			nextToken = response.nextToken;
		} while (nextToken);

		return devices.filter(device => device.remoteAccessEnabled);
	}

	public async listDevices(): Promise<string> {
		const devices = await this.listRemoteAccessDevices();
		return JSON.stringify({
			devices: devices.map(device => ({
				name: device.name,
				platform: toPlatform(device.platform),
				version: device.os,
				formFactor: device.formFactor,
				availability: device.availability,
			})),
		});
	}

	public async allocate(options: DeviceFarmAllocateOptions): Promise<string> {
		const projectArn = this.getProjectArn();
		const wantedPlatform = options.platform === "ios" ? "IOS" : "ANDROID";

		const candidates = (await this.listRemoteAccessDevices())
			.filter(device => device.platform === wantedPlatform)
			.filter(device => device.availability !== "BUSY" && device.availability !== "TEMPORARY_NOT_AVAILABLE")
			.filter(device => !options.name || matchesName(device.name || "", options.name))
			.filter(device => (options.version || []).every(filter => matchesVersion(device.os || "", filter)));

		if (candidates.length === 0) {
			throw new ActionableError("No available AWS Device Farm device matches the given filters. Use mobile_list_remote_devices to see which devices exist");
		}

		// prefer devices that are most likely to be free right now
		const device = candidates.find(d => d.availability === "HIGHLY_AVAILABLE") || candidates[0];

		const response = await this.send(() => this.client.send(new CreateRemoteAccessSessionCommand({
			projectArn,
			deviceArn: device.arn,
			name: SESSION_NAME,
		})));

		let session = toSession(response.remoteAccessSession!);
		if (options.wait) {
			session = await this.waitUntilRunning(session.arn, (options.timeoutSeconds || DEFAULT_ALLOCATE_TIMEOUT_SECONDS) * 1000);
		}

		return JSON.stringify({
			device: session.arn,
			name: session.deviceName,
			platform: session.platform,
			version: session.osVersion,
			status: session.status,
		});
	}

	public async getSession(arn: string): Promise<DeviceFarmSession> {
		const response = await this.send(() => this.client.send(new GetRemoteAccessSessionCommand({ arn })));
		return toSession(response.remoteAccessSession!);
	}

	/**
	 * Wait until the session is running and its appium endpoint is published.
	 */
	public async waitUntilRunning(arn: string, timeoutMs: number): Promise<DeviceFarmSession> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const session = await this.getSession(arn);
			if (session.status === "RUNNING" && session.endpoint) {
				return session;
			}

			if (TERMINAL_SESSION_STATUSES.includes(session.status)) {
				throw new ActionableError(`AWS Device Farm session has ended (status ${session.status}). Allocate a new device with mobile_allocate_remote_device`);
			}

			if (Date.now() > deadline) {
				throw new ActionableError(`AWS Device Farm session is still ${session.status} after ${Math.round(timeoutMs / 1000)} seconds. Try again later`);
			}

			await sleep(POLL_INTERVAL_MS);
		}
	}

	public async release(arn: string): Promise<string> {
		if (!isDeviceFarmSessionArn(arn)) {
			throw new ActionableError(`"${arn}" is not an AWS Device Farm session. Pass the device identifier returned by mobile_allocate_remote_device`);
		}

		const response = await this.send(() => this.client.send(new StopRemoteAccessSessionCommand({ arn })));
		return `Released device, session status: ${response.remoteAccessSession?.status || "UNKNOWN"}`;
	}

	/**
	 * Upload a local app file to the project and install it into a running session.
	 */
	public async installApp(sessionArn: string, platform: DeviceFarmPlatform, appPath: string): Promise<void> {
		const projectArn = this.getProjectArn();
		const extension = path.extname(appPath).toLowerCase();
		let type: UploadType;
		if (platform === "android" && extension === ".apk") {
			type = "ANDROID_APP";
		} else if (platform === "ios" && extension === ".ipa") {
			type = "IOS_APP";
		} else {
			throw new ActionableError(`AWS Device Farm ${platform} devices accept only ${platform === "android" ? ".apk" : ".ipa"} files`);
		}

		const created = await this.send(() => this.client.send(new CreateUploadCommand({
			projectArn,
			name: path.basename(appPath),
			type,
		})));

		const upload = created.upload!;
		const body = await fs.promises.readFile(appPath);
		const put = await fetch(upload.url!, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body,
		});

		if (!put.ok) {
			throw new ActionableError(`Uploading ${appPath} to AWS Device Farm failed: ${put.status} ${await put.text()}`);
		}

		const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
		while (true) {
			const response = await this.send(() => this.client.send(new GetUploadCommand({ arn: upload.arn })));
			const status = response.upload?.status;
			if (status === "SUCCEEDED") {
				break;
			}

			if (status === "FAILED") {
				throw new ActionableError(`AWS Device Farm rejected the app: ${response.upload?.metadata || response.upload?.message || "no details"}`);
			}

			if (Date.now() > deadline) {
				throw new ActionableError("AWS Device Farm is still processing the uploaded app. Try again later");
			}

			await sleep(POLL_INTERVAL_MS);
		}

		await this.send(() => this.client.send(new InstallToRemoteAccessSessionCommand({
			remoteAccessSessionArn: sessionArn,
			appArn: upload.arn,
		})));
	}
}
