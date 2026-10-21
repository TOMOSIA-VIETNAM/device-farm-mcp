import { expect, test } from "@playwright/test";

import { isDeviceFarmSessionArn, matchesName, matchesVersion, toSession } from "../src/device-farm";
import { parseAndroidSource, parseIosSource } from "../src/appium-robot";

const SESSION_ARN = "arn:aws:devicefarm:us-west-2:111122223333:session:abcdef12-1234/abcdef12-5678/00000";

test("recognizes device farm session arns as device ids", () => {
	expect(isDeviceFarmSessionArn(SESSION_ARN)).toBe(true);
	expect(isDeviceFarmSessionArn("arn:aws:devicefarm:us-west-2:111122223333:project:abcdef12-1234")).toBe(false);
	expect(isDeviceFarmSessionArn("emulator-5554")).toBe(false);
});

test("exposes the interactive endpoint of a running session as its viewer url", () => {
	const session = toSession({
		arn: SESSION_ARN,
		status: "RUNNING",
		device: { platform: "ANDROID", name: "Google Pixel 8", os: "14" },
		endpoints: { remoteDriverEndpoint: "https://appium.example/wd/hub", interactiveEndpoint: "https://viewer.example/session" },
	});
	expect(session.endpoint).toBe("https://appium.example/wd/hub");
	expect(session.viewerUrl).toBe("https://viewer.example/session");
	expect(toSession({ arn: SESSION_ARN, status: "PENDING" }).viewerUrl).toBeUndefined();
});

test("matches device names exactly or by trailing wildcard, ignoring case", () => {
	expect(matchesName("Google Pixel 8", "google pixel 8")).toBe(true);
	expect(matchesName("Google Pixel 8 Pro", "Google Pixel 8")).toBe(false);
	expect(matchesName("Apple iPhone 15", "Apple iPhone*")).toBe(true);
	expect(matchesName("Samsung Galaxy S24", "Apple*")).toBe(false);
});

test("matches os versions by prefix or comparison", () => {
	expect(matchesVersion("18.6.2", "18")).toBe(true);
	expect(matchesVersion("18.6.2", "18.6.2")).toBe(true);
	expect(matchesVersion("180", "18")).toBe(false);
	expect(matchesVersion("14", ">=13")).toBe(true);
	expect(matchesVersion("12", ">=13")).toBe(false);
	expect(matchesVersion("17.5", "<18")).toBe(true);
	expect(matchesVersion("18.0", ">18")).toBe(false);
	expect(matchesVersion("18.1", "<=18.1")).toBe(true);
});

test("parses uiautomator2 page source into elements, skipping empty and zero-sized nodes", () => {
	const source = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
	<android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
		<android.widget.TextView class="android.widget.TextView" text="Hello" resource-id="com.example:id/title" bounds="[10,20][110,70]" focused="true" />
		<android.widget.Button class="android.widget.Button" text="" content-desc="Submit" bounds="[0,100][200,200]" />
		<android.view.View class="android.view.View" text="hidden" bounds="[5,5][5,5]" />
	</android.widget.FrameLayout>
</hierarchy>`;

	expect(parseAndroidSource(source)).toEqual([
		{
			type: "android.widget.TextView",
			text: "Hello",
			label: "",
			identifier: "com.example:id/title",
			focused: true,
			rect: { x: 10, y: 20, width: 100, height: 50 },
		},
		{
			type: "android.widget.Button",
			text: "",
			label: "Submit",
			rect: { x: 0, y: 100, width: 200, height: 100 },
		},
	]);
});

test("parses xcuitest page source into visible, labelled elements", () => {
	const source = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
	<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Settings" label="Settings" visible="true" x="0" y="0" width="393" height="852">
		<XCUIElementTypeWindow type="XCUIElementTypeWindow" visible="true" x="0" y="0" width="393" height="852">
			<XCUIElementTypeButton type="XCUIElementTypeButton" name="General" label="General" visible="true" x="16" y="200" width="361" height="44" />
			<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="Offscreen" label="Offscreen" visible="false" x="16" y="900" width="100" height="20" />
			<XCUIElementTypeTextField type="XCUIElementTypeTextField" value="Search" visible="true" x="16" y="100" width="361" height="36" />
		</XCUIElementTypeWindow>
	</XCUIElementTypeApplication>
</AppiumAUT>`;

	expect(parseIosSource(source)).toEqual([
		{
			type: "Button",
			label: "General",
			name: "General",
			value: undefined,
			rect: { x: 16, y: 200, width: 361, height: 44 },
		},
		{
			type: "TextField",
			label: undefined,
			name: undefined,
			value: "Search",
			rect: { x: 16, y: 100, width: 361, height: 36 },
		},
	]);
});
