const builder = require("electron-builder");
const Platform = builder.Platform;

console.log("Starting build, bypassing the terminal entirely...");

builder.build({
  targets: Platform.WINDOWS.createTarget(),
  config: {
    // electron-builder automatically reads your package.json config
  }
}).then((result) => {
  console.log("=========================================");
  console.log("BUILD SUCCESSFUL!");
  console.log("Files output to:", result);
  console.log("=========================================");
  // Keep the window open for 10 seconds so you can see the result
  setTimeout(() => {}, 10000);
}).catch((error) => {
  console.error("BUILD FAILED:");
  console.error(error);
  setTimeout(() => {}, 10000);
});
