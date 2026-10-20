import * as xml from "fast-xml-parser";

import { DeviceFarm, DeviceFarmPlatform } from "./device-farm";
import { ActionableError, Button, ForegroundApp, InstalledApp, Orientation, Robot, ScreenElement, ScreenSize, SwipeDirection } from "./robot";
import { validatePackageName } from "./utils";

// how long a tool call waits for a freshly allocated device before giving up
const ENDPOINT_WAIT_MS = 120 * 1000;
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

const ANDROID_KEYCODES: Record<Button, number> = {
	"HOME": 3,
	"BACK": 4,
	"DPAD_UP": 19,
	"DPAD_DOWN": 20,
	"DPAD_LEFT": 21,
	"DPAD_RIGHT": 22,
	"DPAD_CENTER": 23,
	"VOLUME_UP": 24,
	"VOLUME_DOWN": 25,
	"ENTER": 66,
};

const IOS_BUTTONS: Partial<Record<Button, string>> = {
	"HOME": "home",
	"VOLUME_UP": "volumeUp",
	"VOLUME_DOWN": "volumeDown",
};

const IOS_ACCEPTED_TYPES = ["TextField", "SecureTextField", "Button", "Switch", "Icon", "SearchField", "StaticText", "Image", "Cell", "Link"];

type Attributes = Record<string, string>;

interface XmlNode {
	":@"?: Attributes;
	[tag: string]: XmlNode[] | Attributes | undefined;
}

interface PointerStep {
	type: "pointerMove" | "pointerDown" | "pointerUp" | "pause";
	duration?: number;
	x?: number;
	y?: number;
	button?: number;
}

const walkXml = (nodes: XmlNode[], visit: (tag: string, attributes: Attributes) => void) => {
	for (const node of nodes) {
		const tag = Object.keys(node).find(key => key !== ":@");
		if (!tag) {
			continue;
		}

		visit(tag, node[":@"] || {});
		const children = node[tag];
		if (Array.isArray(children)) {
			walkXml(children, visit);
		}
	}
};

const parseBounds = (bounds: string | undefined) => {
	const [, left, top, right, bottom] = String(bounds).match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.map(Number) || [];
	return {
		x: left || 0,
		y: top || 0,
		width: (right || 0) - (left || 0),
		height: (bottom || 0) - (top || 0),
	};
};

export const parseAndroidSource = (source: string): ScreenElement[] => {
	const elements: ScreenElement[] = [];
	walkXml(parseXml(source), (tag, node) => {
		if (node.text || node["content-desc"] || node.hint || node["resource-id"] || node.checkable === "true") {
			const element: ScreenElement = {
				type: node.class || tag,
				text: node.text,
				label: node["content-desc"] || node.hint || "",
				rect: parseBounds(node.bounds),
			};

			if (node.focused === "true") {
				element.focused = true;
			}

			if (node["resource-id"]) {
				element.identifier = node["resource-id"];
			}

			if (element.rect.width > 0 && element.rect.height > 0) {
				elements.push(element);
			}
		}
	});

	return elements;
};

export const parseIosSource = (source: string): ScreenElement[] => {
	const elements: ScreenElement[] = [];
	walkXml(parseXml(source), (tag, node) => {
		const type = (node.type || tag).replace(/^XCUIElementType/, "");
		if (!IOS_ACCEPTED_TYPES.includes(type) || node.visible !== "true") {
			return;
		}

		const rect = {
			x: Number(node.x),
			y: Number(node.y),
			width: Number(node.width),
			height: Number(node.height),
		};

		if (rect.x < 0 || rect.y < 0 || !(rect.width > 0 && rect.height > 0)) {
			return;
		}

		if (!node.label && !node.name && !node.value) {
			return;
		}

		elements.push({
			type,
			label: node.label,
			name: node.name,
			value: node.value,
			rect,
		});
	});

	return elements;
};

const parseXml = (source: string): XmlNode[] => {
	const parser = new xml.XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: "",
		preserveOrder: true,
	});

	return parser.parse(source) as XmlNode[];
};

/**
 * Drives an AWS Device Farm remote access session through its managed Appium endpoint.
 */
export class AppiumRobot implements Robot {

	private endpoint?: string;
	private platform?: DeviceFarmPlatform;
	private sessionId?: string;

	constructor(private readonly sessionArn: string, private readonly deviceFarm: DeviceFarm) {
	}

	private async getEndpoint(): Promise<string> {
		if (!this.endpoint) {
			const session = await this.deviceFarm.waitUntilRunning(this.sessionArn, ENDPOINT_WAIT_MS);
			this.endpoint = session.endpoint!;
			this.platform = session.platform;
		}

		return this.endpoint;
	}

	private async getPlatform(): Promise<DeviceFarmPlatform> {
		await this.getEndpoint();
		return this.platform!;
	}

	private async http(method: string, path: string, body?: any): Promise<{ status: number, json: any }> {
		const url = new URL(await this.getEndpoint());
		url.pathname = url.pathname.replace(/\/$/, "") + path;

		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers: body === undefined ? undefined : { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (err: any) {
			// the endpoint disappears once the device farm session ends
			this.endpoint = undefined;
			this.sessionId = undefined;
			throw new ActionableError(`Could not reach the AWS Device Farm Appium endpoint (${err.message}). The remote session may have ended; allocate a new device with mobile_allocate_remote_device`);
		}

		const text = await response.text();
		let json: any = {};
		try {
			json = text ? JSON.parse(text) : {};
		} catch {
			json = { value: { message: text } };
		}

		return { status: response.status, json };
	}

	private async createSession(): Promise<string> {
		const platform = await this.getPlatform();
		const alwaysMatch = platform === "ios" ? {
			"platformName": "iOS",
			"appium:automationName": "XCUITest",
		} : {
			"platformName": "Android",
			"appium:automationName": "UiAutomator2",
		};

		const { status, json } = await this.http("POST", "/session", {
			capabilities: {
				alwaysMatch: {
					...alwaysMatch,
					"appium:noReset": true,
					// device farm already ends idle sessions after 5 minutes
					"appium:newCommandTimeout": 0,
				},
			},
		});

		const sessionId = json.value?.sessionId;
		if (status !== 200 || !sessionId) {
			throw new ActionableError(`Failed to start an Appium session on AWS Device Farm: ${json.value?.message || status}`);
		}

		return sessionId;
	}

	private async command(method: string, path: string, body?: any): Promise<any> {
		if (!this.sessionId) {
			this.sessionId = await this.createSession();
		}

		let { status, json } = await this.http(method, `/session/${this.sessionId}${path}`, body);
		if (json.value?.error === "invalid session id") {
			// appium session expired while the device farm session is still alive, start over once
			this.sessionId = await this.createSession();
			({ status, json } = await this.http(method, `/session/${this.sessionId}${path}`, body));
		}

		if (status !== 200 || json.value?.error) {
			throw new ActionableError(`Appium command ${method} ${path} failed: ${json.value?.message || json.value?.error || status}`);
		}

		return json.value;
	}

	private async execute(script: string, args: Record<string, any> = {}): Promise<any> {
		return this.command("POST", "/execute/sync", { script, args: [args] });
	}

	private async appArgs(packageName: string): Promise<Record<string, string>> {
		validatePackageName(packageName);
		return (await this.getPlatform()) === "ios" ? { bundleId: packageName } : { appId: packageName };
	}

	private async performPointer(steps: PointerStep[]): Promise<void> {
		await this.command("POST", "/actions", {
			actions: [{
				type: "pointer",
				id: "finger1",
				parameters: { pointerType: "touch" },
				actions: steps,
			}],
		});
	}

	private async drag(x0: number, y0: number, x1: number, y1: number): Promise<void> {
		await this.performPointer([
			{ type: "pointerMove", duration: 0, x: x0, y: y0 },
			{ type: "pointerDown", button: 0 },
			{ type: "pause", duration: 100 },
			{ type: "pointerMove", duration: 1000, x: x1, y: y1 },
			{ type: "pointerUp", button: 0 },
		]);
	}

	public async getScreenSize(): Promise<ScreenSize> {
		const rect = await this.command("GET", "/window/rect");
		let scale = 1;
		if ((await this.getPlatform()) === "ios") {
			const info = await this.execute("mobile: deviceScreenInfo");
			scale = info?.scale || 1;
		}

		return { width: rect.width, height: rect.height, scale };
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const { width, height } = await this.getScreenSize();
		const centerX = width >> 1;
		const centerY = height >> 1;
		switch (direction) {
			case "up":
				return this.drag(centerX, Math.floor(height * 0.80), centerX, Math.floor(height * 0.20));
			case "down":
				return this.drag(centerX, Math.floor(height * 0.20), centerX, Math.floor(height * 0.80));
			case "left":
				return this.drag(Math.floor(width * 0.80), centerY, Math.floor(width * 0.20), centerY);
			case "right":
				return this.drag(Math.floor(width * 0.20), centerY, Math.floor(width * 0.80), centerY);
			default:
				throw new ActionableError(`Swipe direction "${direction}" is not supported`);
		}
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const { width, height } = await this.getScreenSize();
		const distanceX = distance || Math.floor(width * 0.3);
		const distanceY = distance || Math.floor(height * 0.3);
		switch (direction) {
			case "up":
				return this.drag(x, y, x, Math.max(0, y - distanceY));
			case "down":
				return this.drag(x, y, x, Math.min(height, y + distanceY));
			case "left":
				return this.drag(x, y, Math.max(0, x - distanceX), y);
			case "right":
				return this.drag(x, y, Math.min(width, x + distanceX), y);
			default:
				throw new ActionableError(`Swipe direction "${direction}" is not supported`);
		}
	}

	public async getScreenshot(): Promise<Buffer> {
		const base64 = await this.command("GET", "/screenshot");
		return Buffer.from(base64, "base64");
	}

	public async listApps(): Promise<InstalledApp[]> {
		const value = await this.execute("mobile: listApps");
		// ios answers { bundleId: { CFBundleName, ... } }, android a list or map of package names
		const entries: Array<[string, any]> = Array.isArray(value)
			? value.flatMap((item: any) => typeof item === "string" ? [[item, {}]] : Object.entries(item))
			: Object.entries(value || {});

		return entries.map(([packageName, info]) => ({
			packageName,
			appName: info?.CFBundleDisplayName || info?.CFBundleName || info?.appName || packageName,
		}));
	}

	public async getForegroundApp(): Promise<ForegroundApp> {
		if ((await this.getPlatform()) === "ios") {
			const info = await this.execute("mobile: activeAppInfo");
			return { packageName: info.bundleId, appName: info.name || info.bundleId };
		}

		const packageName = await this.execute("mobile: getCurrentPackage");
		const activity = await this.execute("mobile: getCurrentActivity");
		return { packageName, appName: packageName, activity };
	}

	public async launchApp(packageName: string, locale?: string): Promise<void> {
		if (locale) {
			throw new ActionableError("Launching with a locale is not supported on AWS Device Farm devices");
		}

		await this.execute("mobile: activateApp", await this.appArgs(packageName));
	}

	public async terminateApp(packageName: string): Promise<void> {
		await this.execute("mobile: terminateApp", await this.appArgs(packageName));
	}

	public async installApp(path: string): Promise<void> {
		await this.deviceFarm.installApp(this.sessionArn, await this.getPlatform(), path);
	}

	public async uninstallApp(bundleId: string): Promise<void> {
		await this.execute("mobile: removeApp", await this.appArgs(bundleId));
	}

	public async openUrl(url: string): Promise<void> {
		await this.execute("mobile: deepLink", { url });
	}

	public async sendKeys(text: string): Promise<void> {
		let active: any;
		try {
			active = await this.command("GET", "/element/active");
		} catch {
			throw new ActionableError("No text field is focused. Tap on a text field first, then type");
		}

		await this.command("POST", `/element/${active[ELEMENT_KEY]}/value`, { text });
	}

	public async pressButton(button: Button): Promise<void> {
		if ((await this.getPlatform()) === "android") {
			const keycode = ANDROID_KEYCODES[button];
			if (keycode === undefined) {
				throw new ActionableError(`Button "${button}" is not supported`);
			}

			await this.execute("mobile: pressKey", { keycode });
			return;
		}

		if (button === "ENTER") {
			return this.sendKeys("\n");
		}

		const name = IOS_BUTTONS[button];
		if (!name) {
			throw new ActionableError(`Button "${button}" is not supported on iOS`);
		}

		await this.execute("mobile: pressButton", { name });
	}

	public async tap(x: number, y: number): Promise<void> {
		await this.performPointer([
			{ type: "pointerMove", duration: 0, x, y },
			{ type: "pointerDown", button: 0 },
			{ type: "pause", duration: 50 },
			{ type: "pointerUp", button: 0 },
		]);
	}

	public async doubleTap(x: number, y: number): Promise<void> {
		await this.performPointer([
			{ type: "pointerMove", duration: 0, x, y },
			{ type: "pointerDown", button: 0 },
			{ type: "pause", duration: 50 },
			{ type: "pointerUp", button: 0 },
			{ type: "pause", duration: 100 },
			{ type: "pointerDown", button: 0 },
			{ type: "pause", duration: 50 },
			{ type: "pointerUp", button: 0 },
		]);
	}

	public async longPress(x: number, y: number, duration: number): Promise<void> {
		await this.performPointer([
			{ type: "pointerMove", duration: 0, x, y },
			{ type: "pointerDown", button: 0 },
			{ type: "pause", duration },
			{ type: "pointerUp", button: 0 },
		]);
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		const source = await this.command("GET", "/source");
		return (await this.getPlatform()) === "ios" ? parseIosSource(source) : parseAndroidSource(source);
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		await this.command("POST", "/orientation", { orientation: orientation.toUpperCase() });
	}

	public async getOrientation(): Promise<Orientation> {
		const orientation = await this.command("GET", "/orientation");
		return String(orientation).toLowerCase() === "landscape" ? "landscape" : "portrait";
	}
}
