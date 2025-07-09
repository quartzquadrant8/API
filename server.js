import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { simpleGit } from 'simple-git';
import { execa } from 'execa'; // For running shell commands like npm create vite

// 2. LOAD ENVIRONMENT VARIABLES
dotenv.config();

// --- ADD THIS DEBUG LINE ---
console.log(`[BACKEND DEBUG] GITHUB_PAT value: ${process.env.GITHUB_PAT ? '********** (present)' : 'NOT FOUND / UNDEFINED'}`);
console.log(`[BACKEND DEBUG] GITHUB_USERNAME value: ${process.env.GITHUB_USERNAME ? '********** (present)' : 'NOT FOUND / UNDEFINED'}`);
// --- END DEBUG LINE ---


// 3. INITIALIZE EXPRESS APP
const app = express();
const PORT = process.env.PORT || 3000;

// Constants for directories
const CLONED_REPOS_BASE_DIR = '/data/data/com.termux/files/home/cloned_repos';
const VITE_SCAFFOLDS_BASE_DIR = '/data/data/com.termux/files/home/vite_scaffolds';

// Get your own GitHub Username from .env for cloning repos by default
const YOUR_GITHUB_USERNAME = process.env.GITHUB_USERNAME;

// Path to the run-vite-project.sh script within *this* backend project
// IMPORTANT: This path assumes my-github-app-repo is a sibling of API
const RUN_VITE_PROJECT_SCRIPT_TEMPLATE = path.join(process.cwd(), '../my-github-app-repo/scripts/run-vite-project.sh');

// 4. APPLY MIDDLEWARE
app.use(cors()); // Enables Cross-Origin Resource Sharing
app.use(express.json()); // Essential for parsing JSON request bodies (req.body)

// --- Helper function to convert HTTPS to SSH URL ---
function convertToSshUrl(httpsUrl) {
    if (httpsUrl.startsWith('https://github.com/')) {
        // Example: https://github.com/user/repo.git -> git@github.com:user/repo.git
        return httpsUrl.replace('https://github.com/', 'git@github.com:').replace(/\.git$/, '.git');
    }
    // If it's already SSH or another protocol, return as is
    return httpsUrl;
}

// --- GITHUB API INTERACTION FUNCTIONS (using axios for actual GitHub API calls) ---
// Note: These API calls use PAT, not SSH, as they are direct HTTP API requests.
async function getReposFromGitHub(username, githubToken) {
    try {
        const response = await axios.get(`https://api.github.com/users/${username}/repos`, {
            headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching repos from GitHub:', error.response ? error.response.data : error.message);
        throw new Error(error.response?.data?.message || 'Failed to fetch repositories from GitHub.');
    }
}

async function createRepoOnGitHub(repoDetails, githubToken) {
    try {
        const response = await axios.post('https://api.github.com/user/repos', repoDetails, {
            headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error creating repo on GitHub:', error.response ? error.response.data : error.message);
        throw new Error(error.response?.data?.message || 'Failed to create repository on GitHub.');
    }
}

// --- BACKEND API ROUTES ---

// Route to fetch repositories
app.get('/api/repos', async (req, res) => {
    const username = req.query.username;
    const githubToken = process.env.GITHUB_PAT;

    if (!username) {
        return res.status(400).json({ message: 'GitHub username is required.' });
    }
    if (!githubToken) {
        return res.status(500).json({ message: 'GitHub Personal Access Token (GITHUB_PAT) is not configured on the server.' });
    }

    try {
        const repos = await getReposFromGitHub(username, githubToken);
        res.json(repos);
    } catch (error) {
        console.error('[BACKEND] Error in /api/repos:', error.message);
        res.status(500).json({ message: error.message });
    }
});

// Route to create a new repository
app.post('/api/create-repo', async (req, res) => {
    const { name, description } = req.body;
    const githubToken = process.env.GITHUB_PAT;

    if (!name) {
        return res.status(400).json({ message: 'Repository name is required.' });
    }
    if (!githubToken) {
        return res.status(500).json({ message: 'GitHub Personal Access Token (GITHUB_PAT) is not configured on the server.' });
    }

    try {
        const newRepo = await createRepoOnGitHub({ name, description, auto_init: true }, githubToken);
        res.status(201).json(newRepo); // 201 Created
    } catch (error) {
        console.error('[BACKEND] Error in /api/create-repo:', error.message);
        res.status(500).json({ message: error.message });
    }
});


// --- NEW: Scaffold Vite Project Route ---
app.post('/api/scaffold-vite', async (req, res) => {
    const { projectName, template } = req.body;
    console.log(`[BACKEND] Scaffolding request: Project=${projectName}, Template=${template}`);

    if (!projectName) {
        return res.status(400).json({ message: 'Project name is required for scaffolding.' });
    }

    const projectPath = path.join(VITE_SCAFFOLDS_BASE_DIR, projectName);

    try {
        // Ensure base directory exists
        await fs.promises.mkdir(VITE_SCAFFOLDS_BASE_DIR, { recursive: true });

        // Check if project directory already exists
        const projectExists = await fs.promises.stat(projectPath).then(stat => stat.isDirectory()).catch(() => false);
        if (projectExists) {
            return res.status(409).json({ message: `Project directory '${projectName}' already exists. Please choose a different name or delete it first.` });
        }

        // Run 'npm create vite@latest <projectName> -- --template <template>'
        console.log(`[BACKEND] Running: npm create vite@latest ${projectName} -- --template ${template} in ${VITE_SCAFFOLDS_BASE_DIR}`);
        const { stdout, stderr } = await execa('npm', ['create', 'vite@latest', projectName, '--', '--template', template], { cwd: VITE_SCAFFOLDS_BASE_DIR });

        console.log(`[BACKEND] Scaffold stdout: ${stdout}`);
        if (stderr) console.warn(`[BACKEND] Scaffold stderr: ${stderr}`);

        // Copy run-vite-project.sh into the newly scaffolded project
        const runScriptDestPath = path.join(projectPath, 'run-vite-project.sh');
        await fs.promises.copyFile(RUN_VITE_PROJECT_SCRIPT_TEMPLATE, runScriptDestPath);
        await fs.promises.chmod(runScriptDestPath, 0o755); // Make it executable
        console.log(`[BACKEND] Copied and made executable: ${runScriptDestPath}`);

        res.status(200).json({
            message: `Vite project '${projectName}' scaffolded successfully!`,
            path: projectPath,
            stdout: stdout
        });

    } catch (error) {
        console.error(`[BACKEND] Error scaffolding Vite project:`, error);
        res.status(500).json({ message: `Failed to scaffold Vite project: ${error.message}` });
    }
});


// --- NEW/MODIFIED: Upload Vite Project Route ---
app.post('/api/upload-vite-project', async (req, res) => {
    const { sourceLocalPath, repoName, branchName, commitMessage } = req.body;
    const githubToken = process.env.GITHUB_PAT;
    const actualBranchName = branchName || 'main';

    console.log(`[BACKEND] Upload request: Source=${sourceLocalPath}, Repo=${repoName}, Branch=${actualBranchName}, Commit=${commitMessage}`);

    if (!sourceLocalPath || !repoName || !commitMessage) {
        return res.status(400).json({ message: 'Local project path, target repository name, and commit message are required for upload.' });
    }
    if (!githubToken) {
        return res.status(500).json({ message: 'GitHub Personal Access Token (GITHUB_PAT) is not configured on the server.' });
    }
    if (!YOUR_GITHUB_USERNAME) {
        return res.status(500).json({ message: 'GITHUB_USERNAME environment variable is not configured on the server. Needed for constructing repo URL.' });
    }

    try {
        // 1. Validate sourceLocalPath is a directory and contains package.json
        const sourcePathStat = await fs.promises.stat(sourceLocalPath).catch(() => null);
        if (!sourcePathStat || !sourcePathStat.isDirectory()) {
            return res.status(404).json({ message: `Source local path "${sourceLocalPath}" not found or is not a directory.` });
        }
        if (!await fs.promises.stat(path.join(sourceLocalPath, 'package.json')).catch(() => null)) {
             return res.status(400).json({ message: `"${sourceLocalPath}" does not appear to be a Node.js project (package.json not found).` });
        }
        // Ensure run-vite-project.sh exists and copy it if missing (e.g., if user manually created project)
        if (!await fs.promises.stat(path.join(sourceLocalPath, 'run-vite-project.sh')).catch(() => null)) {
            const runScriptDestPath = path.join(sourceLocalPath, 'run-vite-project.sh');
            await fs.promises.copyFile(RUN_VITE_PROJECT_SCRIPT_TEMPLATE, runScriptDestPath);
            await fs.promises.chmod(runScriptDestPath, 0o755);
            console.log(`[BACKEND] run-vite-project.sh copied to source project: ${runScriptDestPath}`);
        }


        // 2. Initialize simple-git in the source local project path
        const git = simpleGit({ baseDir: sourceLocalPath });
        // Use SSH URL for Git operations
        const remoteUrl = `git@github.com:${YOUR_GITHUB_USERNAME}/${repoName}.git`;

        // Check if it's already a Git repository
        const isRepo = await git.checkIsRepo().catch(() => false);

        if (!isRepo) {
            console.log(`[BACKEND] Initializing new Git repository in ${sourceLocalPath}`);
            await git.init();
            await git.addRemote('origin', remoteUrl);
            console.log(`[BACKEND] Git initialized and remote added: ${remoteUrl}`);
        } else {
            // Ensure the remote 'origin' is set correctly for SSH
            const remotes = await git.getRemotes(true);
            if (!remotes.some(r => r.name === 'origin')) {
                await git.addRemote('origin', remoteUrl);
                console.log(`[BACKEND] Re-added missing 'origin' remote: ${remoteUrl}`);
            } else {
                const currentOrigin = remotes.find(r => r.name === 'origin');
                // Check if current origin URL is different from desired SSH URL
                if (currentOrigin && currentOrigin.refs.fetch !== remoteUrl) {
                    console.log(`[BACKEND] Updating 'origin' remote URL from ${currentOrigin.refs.fetch} to ${remoteUrl}`);
                    await git.removeRemote('origin');
                    await git.addRemote('origin', remoteUrl);
                }
            }
        }

        // 3. Checkout or create the target branch
        try {
            await git.checkout(actualBranchName);
            console.log(`[BACKEND] Checked out branch: ${actualBranchName}`);
        } catch (checkoutError) {
            if (checkoutError.message.includes('pathspec') || checkoutError.message.includes('not found')) {
                console.warn(`[BACKEND] Branch ${actualBranchName} not found locally, attempting to create and checkout.`);
                await git.checkout(['-b', actualBranchName]);
                console.log(`[BACKEND] Created and checked out new branch: ${actualBranchName}`);
            } else {
                throw checkoutError; // Re-throw other checkout errors
            }
        }

        // 4. Stage, Commit, Push
        await git.add('.'); // Add all new/modified files in the project
        console.log(`[BACKEND] Added all changes to staging.`);

        const commitResult = await git.commit(commitMessage);
        console.log(`[BACKEND] Committed changes: ${commitResult.commit}`);

        // Push with --set-upstream for new branches
        const branchSummary = await git.branch(['--show-current']);
        if (branchSummary.current === actualBranchName) {
            try {
                await git.push('origin', actualBranchName, {'--set-upstream': null});
                console.log(`[BACKEND] Pushed to remote branch ${actualBranchName} with upstream set.`);
            } catch (pushError) {
                console.warn(`[BACKEND] Set-upstream failed, attempting regular push: ${pushError.message}`);
                await git.push('origin', actualBranchName);
                console.log(`[BACKEND] Pushed to remote branch ${actualBranchName} (regular push).`);
            }
        } else {
            await git.push('origin', actualBranchName);
            console.log(`[BACKEND] Pushed to remote branch ${actualBranchName}.`);
        }

        res.status(200).json({
            message: `Successfully uploaded Vite project from "${path.basename(sourceLocalPath)}" to "${repoName}/${actualBranchName}". Commit: ${commitResult.commit}`,
            repoUrl: `https://github.com/${YOUR_GITHUB_USERNAME}/${repoName}/tree/${actualBranchName}` // Still provide HTTPS URL for web viewing
        });

    } catch (error) {
        console.error(`[BACKEND] Error during upload Vite project:`, error);
        res.status(500).json({ message: `Failed to upload Vite project: ${error.message}` });
    }
});


// --- NEW: Download & Prepare Vite Project Route ---
app.post('/api/download-and-prepare', async (req, res) => {
    const { githubRepoUrl, branchName, localDownloadPath } = req.body;
    const actualBranchName = branchName || 'main';

    console.log(`[BACKEND] Download request: URL=${githubRepoUrl}, Branch=${actualBranchName}, Path=${localDownloadPath}`);

    if (!githubRepoUrl || !localDownloadPath) {
        return res.status(400).json({ message: 'GitHub repository URL and local download path are required.' });
    }

    try {
        // Ensure parent directory for localDownloadPath exists
        const parentDir = path.dirname(localDownloadPath);
        await fs.promises.mkdir(parentDir, { recursive: true });
        console.log(`[BACKEND] Ensured parent directory exists: ${parentDir}`);

        // Convert the input URL to SSH format for cloning
        const sshRepoUrl = convertToSshUrl(githubRepoUrl);
        console.log(`[BACKEND] Converted repo URL to SSH for cloning: ${sshRepoUrl}`);

        // Check if target download path already exists
        const targetPathExists = await fs.promises.stat(localDownloadPath).then(stat => stat.isDirectory()).catch(() => false);
        if (targetPathExists) {
            console.warn(`[BACKEND] Target download path ${localDownloadPath} already exists. Attempting to pull if it's a Git repo.`);
            const gitPull = simpleGit({ baseDir: localDownloadPath });
            try {
                // Ensure the remote is set to SSH if it was previously HTTPS
                const remotes = await gitPull.getRemotes(true);
                const currentOrigin = remotes.find(r => r.name === 'origin');
                if (currentOrigin && currentOrigin.refs.fetch !== sshRepoUrl) {
                    await gitPull.removeRemote('origin');
                    await gitPull.addRemote('origin', sshRepoUrl);
                    console.log(`[BACKEND] Updated 'origin' remote to SSH for pulling: ${sshRepoUrl}`);
                }
                await gitPull.pull('origin', actualBranchName);
                console.log(`[BACKEND] Pulled latest changes for ${localDownloadPath}`);
            } catch (pullError) {
                console.error(`[BACKEND] Failed to pull existing repo, attempting to remove and re-clone: ${pullError.message}`);
                await fs.promises.rm(localDownloadPath, { recursive: true, force: true });
                // Fall through to cloning
            }
        }

        // Clone the repository if it doesn't exist or was removed
        if (!targetPathExists || (targetPathExists && !await fs.promises.stat(localDownloadPath).then(stat => stat.isDirectory()).catch(() => false))) {
            console.log(`[BACKEND] Cloning ${sshRepoUrl} to ${localDownloadPath} (branch: ${actualBranchName})`);
            const gitClone = simpleGit(); // Use default baseDir for initial clone, then specify
            await gitClone.clone(sshRepoUrl, localDownloadPath, ['--branch', actualBranchName]);
            console.log(`[BACKEND] Successfully cloned ${sshRepoUrl}`);
        }

        // Change directory into the cloned project and run npm install
        console.log(`[BACKEND] Changing directory to ${localDownloadPath} for npm install.`);
        const { stdout: npmInstallStdout, stderr: npmInstallStderr } = await execa('npm', ['install'], { cwd: localDownloadPath });
        console.log(`[BACKEND] npm install stdout: ${npmInstallStdout}`);
        if (npmInstallStderr) console.warn(`[BACKEND] npm install stderr: ${npmInstallStderr}`);
        console.log(`[BACKEND] npm install completed for ${localDownloadPath}`);

        // Ensure run-vite-project.sh exists and is executable in the downloaded project
        const runScriptPathInProject = path.join(localDownloadPath, 'run-vite-project.sh');
        if (!await fs.promises.stat(runScriptPathInProject).catch(() => null)) {
            // If the repo didn't contain it, copy it from our template
            await fs.promises.copyFile(RUN_VITE_PROJECT_SCRIPT_TEMPLATE, runScriptPathInProject);
            console.log(`[BACKEND] run-vite-project.sh copied into downloaded project.`);
        }
        await fs.promises.chmod(runScriptPathInProject, 0o755); // Make it executable
        console.log(`[BACKEND] run-vite-project.sh is executable in downloaded project.`);


        res.status(200).json({
            message: `Project cloned and prepared successfully!`,
            path: localDownloadPath,
        });

    } catch (error) {
        console.error(`[BACKEND] Error during download and prepare:`, error);
        // Attempt to clean up partially cloned/installed directory if error occurred
        try {
            if (await fs.promises.stat(localDownloadPath).catch(() => null)) {
                await fs.promises.rm(localDownloadPath, { recursive: true, force: true });
                console.log(`[BACKEND] Cleaned up partial download directory: ${localDownloadPath}`);
            }
        } catch (cleanupError) {
            console.error(`[BACKEND] Error during cleanup of ${localDownloadPath}:`, cleanupError.message);
        }
        res.status(500).json({ message: `Failed to download and prepare project: ${error.message}` });
    }
});


// 5. START THE SERVER (always at the very end)
app.listen(PORT, () => {
    console.log(`[BACKEND] Server listening on port ${PORT}`);
});
