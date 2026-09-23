const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const REQUIRED_ARTIFACTS = Object.freeze([
    "cli-version.json",
    "cli-output.json",
    "cli-namespace.json",
    "namespace-mapping.json",
]);

async function pathExists(candidatePath) {
    try {
        await fs.access(candidatePath);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

function runCommand(command, args, { cwd, timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error(`${command} timed out after ${timeoutMs} ms`));
        }, timeoutMs);

        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("close", (exitCode) => {
            clearTimeout(timeout);
            if (exitCode === 0) {
                resolve(Buffer.concat(stdout).toString("utf8").trim());
                return;
            }
            reject(new Error(
                `${command} ${args.join(" ")} exited with code ${exitCode}: `
                + Buffer.concat(stderr).toString("utf8").trim(),
            ));
        });
    });
}

function sanitizeJson(json) {
    return json.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function compareCaseInsensitive(left, right) {
    return left.toLowerCase().localeCompare(right.toLowerCase())
        || left.localeCompare(right);
}

function createNamespaceMapping(toolsDocument, brandMappings, version, generatedAt = new Date().toISOString()) {
    if (!Array.isArray(toolsDocument.results)) {
        throw new Error("azmcp tools list output does not contain a results array");
    }

    const unclaimedTools = [...toolsDocument.results];
    const namespaces = {};
    const sortedMappings = brandMappings
        .filter((mapping) => typeof mapping.mcpServerName === "string" && mapping.mcpServerName)
        .sort((left, right) => right.mcpServerName.length - left.mcpServerName.length);

    for (const mapping of sortedMappings) {
        const normalizedNamespace = mapping.mcpServerName.replaceAll("_", " ").toLowerCase();
        const matchedTools = [];

        for (let index = unclaimedTools.length - 1; index >= 0; index -= 1) {
            const command = unclaimedTools[index].command ?? "";
            const normalizedCommand = command.toLowerCase();
            if (
                normalizedCommand === normalizedNamespace
                || normalizedCommand.startsWith(`${normalizedNamespace} `)
            ) {
                const [tool] = unclaimedTools.splice(index, 1);
                matchedTools.push(tool.name || tool.command);
            }
        }

        namespaces[mapping.mcpServerName] = {
            display_name: mapping.brandName,
            file_name: mapping.fileName,
            short_name: mapping.shortName,
            merge_group: mapping.mergeGroup ?? null,
            tools: matchedTools.sort(compareCaseInsensitive),
        };
    }

    const unmatchedTools = unclaimedTools
        .map((tool) => tool.name || tool.command)
        .sort(compareCaseInsensitive);

    return {
        generated_at: generatedAt,
        source_version: version,
        namespace_count: Object.keys(namespaces).length,
        tool_count: Object.values(namespaces)
            .reduce((count, namespace) => count + namespace.tools.length, 0),
        namespaces,
        unmatched_tools: unmatchedTools,
    };
}

async function runAzmcp(args, rootDir) {
    const entryPoint = path.join(rootDir, "node_modules", "@azure", "mcp", "index.js");
    if (!await pathExists(entryPoint)) {
        throw new Error("Missing @azure/mcp installation. Run npm install before creating a snapshot.");
    }
    return runCommand(process.execPath, [entryPoint, ...args], { cwd: rootDir });
}

async function runExtractor(temporaryOutputDirectory, rootDir) {
    const cliDirectory = path.join(temporaryOutputDirectory, "cli");
    await fs.mkdir(cliDirectory, { recursive: true });

    const [version, toolsJson, namespaceJson] = await Promise.all([
        runAzmcp(["--version"], rootDir),
        runAzmcp(["tools", "list"], rootDir),
        runAzmcp(["tools", "list", "--namespace-mode"], rootDir),
    ]);
    const sanitizedToolsJson = sanitizeJson(toolsJson);
    const sanitizedNamespaceJson = sanitizeJson(namespaceJson);
    const toolsDocument = JSON.parse(sanitizedToolsJson);
    JSON.parse(sanitizedNamespaceJson);

    const brandMappings = JSON.parse(await fs.readFile(
        path.join(rootDir, "config", "brand-to-server-mapping.json"),
        "utf8",
    ));
    const namespaceMapping = createNamespaceMapping(toolsDocument, brandMappings, version);

    await Promise.all([
        fs.writeFile(
            path.join(cliDirectory, "cli-version.json"),
            `${JSON.stringify({ version }, null, 2)}\n`,
            "utf8",
        ),
        fs.writeFile(path.join(cliDirectory, "cli-output.json"), `${sanitizedToolsJson}\n`, "utf8"),
        fs.writeFile(
            path.join(cliDirectory, "cli-namespace.json"),
            `${sanitizedNamespaceJson}\n`,
            "utf8",
        ),
        fs.writeFile(
            path.join(cliDirectory, "namespace-mapping.json"),
            `${JSON.stringify(namespaceMapping, null, 2)}\n`,
            "utf8",
        ),
    ]);
}

function validateVersionDirectoryName(version) {
    if (
        typeof version !== "string"
        || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)
        || version === "."
        || version === ".."
    ) {
        throw new Error(`CLI returned an unsafe version directory name: ${JSON.stringify(version)}`);
    }
}

async function createVersionSnapshot({
    rootDir = __dirname,
    runExtractor: extract = (temporaryOutputDirectory) => runExtractor(
        temporaryOutputDirectory,
        rootDir,
    ),
} = {}) {
    const temporaryOutputDirectory = await fs.mkdtemp(
        path.join(path.resolve(rootDir), ".mcp-cli-snapshot-tmp-"),
    );
    const cliDirectory = path.join(temporaryOutputDirectory, "cli");

    try {
        await extract(temporaryOutputDirectory);

        for (const fileName of REQUIRED_ARTIFACTS) {
            const artifactPath = path.join(cliDirectory, fileName);
            if (!await pathExists(artifactPath)) {
                throw new Error(`Missing required metadata artifact: ${artifactPath}`);
            }
        }

        const versionDocument = JSON.parse(
            await fs.readFile(path.join(cliDirectory, "cli-version.json"), "utf8"),
        );
        const { version } = versionDocument;
        validateVersionDirectoryName(version);

        const versionDirectory = path.join(rootDir, version);
        if (await pathExists(versionDirectory)) {
            throw new Error(`Version snapshot already exists: ${versionDirectory}`);
        }

        await fs.rename(cliDirectory, versionDirectory);
        const trackedVersion = version.split("+", 1)[0];
        await fs.writeFile(
            path.join(rootDir, "tracked-version.txt"),
            `${trackedVersion}\n`,
            "utf8",
        );
        return versionDirectory;
    } finally {
        await fs.rm(temporaryOutputDirectory, { recursive: true, force: true });
    }
}

async function main() {
    const versionDirectory = await createVersionSnapshot();
    console.log(`Created CLI metadata snapshot: ${versionDirectory}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Failed to create CLI metadata snapshot: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    REQUIRED_ARTIFACTS,
    createNamespaceMapping,
    createVersionSnapshot,
    sanitizeJson,
};
