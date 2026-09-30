import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { dataHome, desktopProfileName, kept, localEnvFile, projectConfigFile, taskFolderRoot } from "../src/install-names.js";

// An installation made before the product was renamed keeps every place it has
// (install-names.js); a new one gets the new names. Asked of a pretend disk.
const disk = (...present) => (file) => present.includes(file);
const home = "/Users/someone";

test("an installation from before the rename keeps its folders, and a new one gets the new names", () => {
  for (const [label, legacy, current, find] of [
    ["data", `${home}/.mydoubao`, `${home}/.idou`, (exists) => dataHome({ home, exists })],
    ["tasks", `${home}/我的豆包`, `${home}/i豆`, (exists) => taskFolderRoot({ home, exists, dataDir: null })],
  ]) {
    assert.equal(find(disk()), current, `${label}: a new installation`);
    assert.equal(find(disk(legacy)), legacy, `${label}: one from before the rename`);
    assert.equal(find(disk(current)), current, `${label}: one made since`);
    assert.equal(find(disk(legacy, current)), legacy, `${label}: an old folder is never hidden by a new one made beside it`);
  }
  const appData = `${home}/Library/Application Support`;
  assert.equal(desktopProfileName({ appData, exists: disk() }), "i豆");
  assert.equal(desktopProfileName({ appData, exists: disk(path.join(appData, "我的豆包")) }), "我的豆包", "the name its Keychain item was made under");
  assert.equal(kept("new", "old", disk("old")), "old");
});

// A desktop on a profile of its own -- development, every acceptance run --
// keeps its task folders in that profile, not in the person's home.
test("a desktop on a profile of its own keeps its task folders there", () => {
  assert.equal(taskFolderRoot({ home, exists: disk(`${home}/我的豆包`), dataDir: "/tmp/acceptance-profile" }), "/tmp/acceptance-profile/task-folders");
});

test("the deployment file and a project's settings are found under either name, the new one first", () => {
  assert.equal(localEnvFile({ home, exists: disk(`${home}/.mydoubao`, `${home}/.mydoubao/mydoubao.env`) }), `${home}/.mydoubao/mydoubao.env`);
  assert.equal(localEnvFile({ home, exists: disk(`${home}/.mydoubao`, `${home}/.mydoubao/mydoubao.env`, `${home}/.mydoubao/idou.env`) }), `${home}/.mydoubao/idou.env`);
  assert.equal(localEnvFile({ home, exists: disk() }), `${home}/.idou/idou.env`);
  assert.equal(projectConfigFile("/work", disk("/work/.mydoubao.json")), "/work/.mydoubao.json");
  assert.equal(projectConfigFile("/work", disk("/work/.mydoubao.json", "/work/.idou.json")), "/work/.idou.json");
  assert.equal(projectConfigFile("/work", disk()), "/work/.idou.json");
});
