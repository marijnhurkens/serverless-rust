"use strict";

// https://serverless.com/blog/writing-serverless-plugins/
// https://serverless.com/framework/docs/providers/aws/guide/plugins/
// https://github.com/softprops/lambda-rust/

const { spawnSync } = require("child_process");
const { homedir, platform } = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const { mkdirSync, writeFileSync, readFileSync } = require("fs");

const DEFAULT_DOCKER_TAG = "0.2.7-rust-1.43.0";
const DEFAULT_DOCKER_IMAGE = "softprops/lambda-rust";
const RUST_RUNTIME = "rust";
const BASE_RUNTIME = "provided";
const NO_OUTPUT_CAPTURE = { stdio: ["ignore", process.stdout, process.stderr] };
const MUSL_PLATFORMS = ["darwin", "windows"];

function includeInvokeHook(serverlessVersion) {
  let [major, minor] = serverlessVersion.split(".");
  let majorVersion = parseInt(major);
  let minorVersion = parseInt(minor);
  return majorVersion === 1 && minorVersion >= 38 && minorVersion < 40;
}

/** assumes docker is on the host's execution path */
class RustPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.servicePath = this.serverless.config.servicePath || "";
    this.hooks = {
      "before:package:createDeploymentArtifacts": this.build.bind(this),
      "before:deploy:function:packageFunction": this.build.bind(this),
    };
    if (includeInvokeHook(serverless.version)) {
      this.hooks["before:invoke:local:invoke"] = this.build.bind(this);
    }
    this.custom = Object.assign(
      {
        cargoFlags: "",
        dockerTag: DEFAULT_DOCKER_TAG,
        dockerImage: DEFAULT_DOCKER_IMAGE,
        dockerless: false,
      },
      (this.serverless.service.custom && this.serverless.service.custom.rust) ||
        {}
    );

    this.dockerPath = path.resolve(this.custom.dockerPath || this.servicePath);

    // By default, Serverless examines node_modules to figure out which
    // packages there are from dependencies versus devDependencies of a
    // package. While there will always be a node_modules due to Serverless
    // and this plugin being installed, it will be excluded anyway.
    // Therefore, the filtering can be disabled to speed up (~3.2s) the process.
    this.serverless.service.package.excludeDevDependencies = false;
  }

  localBuild(funcArgs, cargoPackage, binary, profile) {
    const defaultArgs = ["build", "-p", cargoPackage];
    const profileArgs = profile !== "dev" ? ["--release"] : [];
    const cargoFlags = (
      (funcArgs || {}).cargoFlags ||
      this.custom.cargoFlags ||
      ""
    ).split(/\s+/);
    const targetArgs = MUSL_PLATFORMS.includes(platform())
      ? ["--target", "x86_64-unknown-linux-musl"]
      : [];
    const finalArgs = [
      ...defaultArgs,
      ...profileArgs,
      ...targetArgs,
      ...cargoFlags,
    ].filter((i) => i);
    const defaultEnv = { ...process.env };
    const platformEnv =
      platform() === "darwin"
        ? {
            RUSTFLAGS:
              (process.env["RUSTFLAGS"] || "") +
              " -Clinker=x86_64-linux-musl-gcc",
            TARGET_CC: "x86_64-linux-musl-gcc",
            CC_x86_64_unknown_linux_musl: "x86_64-linux-musl-gcc",
          }
        : platform() === "windows"
        ? {
            RUSTFLAGS: (process.env["RUSTFLAGS"] || "") + " -Clinker=rust-lld",
            TARGET_CC: "rust-lld",
            CC_x86_64_unknown_linux_musl: "rust-lld",
          }
        : {};
    const finalEnv = {
      ...defaultEnv,
      ...platformEnv,
    };
    this.serverless.cli.log("Running local cargo build");

    const buildResult = spawnSync("cargo", finalArgs, {
      ...NO_OUTPUT_CAPTURE,
      ...{
        env: finalEnv,
      },
    });
    if (buildResult.error || buildResult.status > 0) {
      return buildResult;
    }
    // now rename binary and zip
    let executable = "target";
    if (MUSL_PLATFORMS.includes(platform())) {
      executable = path.join(executable, "x86_64-unknown-linux-musl");
    }
    executable = path.join(executable, profile !== "dev" ? "release" : "debug");
    const zip = new AdmZip();
    zip.addFile(
      "bootstrap",
      readFileSync(path.join(executable, binary)),
      "",
      755
    );
    const targetDir = path.join(
      "target",
      "lambda",
      profile !== "dev" ? "release" : "debug"
    );
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch {}
    try {
      writeFileSync(path.join(targetDir, `${binary}.zip`), zip.toBuffer());
      return {};
    } catch (err) {
      this.serverless.cli.log(`Error zipping artifact ${err}`);
      return {
        err: err,
        status: 1,
      };
    }
  }

  dockerBuild(funcArgs, cargoPackage, binary, profile) {
    const cargoHome = process.env.CARGO_HOME || path.join(homedir(), ".cargo");
    const cargoRegistry = path.join(cargoHome, "registry");
    const cargoDownloads = path.join(cargoHome, "git");

    const dockerCLI = process.env["SLS_DOCKER_CLI"] || "docker";
    const defaultArgs = [
      "run",
      "--rm",
      "-t",
      "-e",
      `BIN=${binary}`,
      `-v`,
      `${this.dockerPath}:/code`,
      `-v`,
      `${cargoRegistry}:/root/.cargo/registry`,
      `-v`,
      `${cargoDownloads}:/root/.cargo/git`,
    ];
    const customArgs = (process.env["SLS_DOCKER_ARGS"] || "").split(" ") || [];

    let cargoFlags = (funcArgs || {}).cargoFlags || this.custom.cargoFlags;
    if (profile) {
      // release or dev
      customArgs.push("-e", `PROFILE=${profile}`);
    }
    if (cargoPackage != undefined) {
      if (cargoFlags) {
        cargoFlags = `${cargoFlags} -p ${cargoPackage}`;
      } else {
        cargoFlags = ` -p ${cargoPackage}`;
      }
    }
    if (cargoFlags) {
      // --features awesome-feature, ect
      customArgs.push("-e", `CARGO_FLAGS=${cargoFlags}`);
    }
    const dockerTag = (funcArgs || {}).dockerTag || this.custom.dockerTag;
    const dockerImage = (funcArgs || {}).dockerImage || this.custom.dockerImage;

    const finalArgs = [
      ...defaultArgs,
      ...customArgs,
      `${dockerImage}:${dockerTag}`,
    ].filter((i) => i);

    this.serverless.cli.log("Running containerized build");

    return spawnSync(dockerCLI, finalArgs, NO_OUTPUT_CAPTURE);
  }

  functions() {
    if (this.options.function) {
      return [this.options.function];
    } else {
      return this.serverless.service.getAllFunctions();
    }
  }

  cargoBinary(func) {
    let [cargoPackage, binary] = func.handler.split(".");
    if (binary == undefined) {
      binary = cargoPackage;
    }
    return { cargoPackage, binary };
  }

  buildLocally(func) {
    return (func.rust || {}).dockerless || this.custom.dockerless;
  }

  build() {
    const service = this.serverless.service;
    if (service.provider.name != "aws") {
      return;
    }
    let rustFunctionsFound = false;
    this.functions().forEach((funcName) => {
      const func = service.getFunction(funcName);
      const runtime = func.runtime || service.provider.runtime;
      if (runtime != RUST_RUNTIME) {
        // skip functions which don't apply to rust
        return;
      }
      rustFunctionsFound = true;
      const { cargoBinary, binary } = this.cargoBinary(func);

      this.serverless.cli.log(`Building Rust ${func.handler} func...`);
      let profile = (func.rust || {}).profile || this.custom.profile;

      const res = this.buildLocally(func)
        ? this.localBuild(func.rust, cargoPackage, binary, profile)
        : this.dockerBuild(func.rust, cargoPackage, binary, profile);
      if (res.error || res.status > 0) {
        this.serverless.cli.log(
          `Rust build encountered an error: ${res.error} ${res.status}.`
        );
        throw new Error(res.error);
      }
      // If all went well, we should now have find a packaged compiled binary under `target/lambda/release`.
      //
      // The AWS "provided" lambda runtime requires executables to be named
      // "bootstrap" -- https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
      //
      // To avoid artifact naming conflicts when we potentially have more than one function
      // we leverage the ability to declare a package artifact directly
      // see https://serverless.com/framework/docs/providers/aws/guide/packaging/
      // for more information
      const artifactPath = path.join(
        this.dockerPath,
        `target/lambda/${"dev" === profile ? "debug" : "release"}`,
        `${binary}.zip`
      );
      func.package = func.package || {};
      func.package.artifact = artifactPath;

      // Ensure the runtime is set to a sane value for other plugins
      if (func.runtime == RUST_RUNTIME) {
        func.runtime = BASE_RUNTIME;
      }
    });
    if (service.provider.runtime === RUST_RUNTIME) {
      service.provider.runtime = BASE_RUNTIME;
    }
    if (!rustFunctionsFound) {
      throw new Error(
        `Error: no Rust functions found. ` +
          `Use 'runtime: ${RUST_RUNTIME}' in global or ` +
          `function configuration to use this plugin.`
      );
    }
  }
}

module.exports = RustPlugin;
