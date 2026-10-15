function cleanup = directory(root)
% Scope MATLAB's lookup paths to one request or process-worker Job.
oldPath = path;
oldFolder = pwd;
cleanup = onCleanup(@() restore(oldFolder, oldPath));
ancestor = string(root);
while true
    common = fullfile(ancestor, "common");
    if isfile(fullfile(common, "+store", "loadSchemes.m"))
        addpath(common);
        break
    end
    parent = fileparts(ancestor);
    if parent == ancestor, break; end
    ancestor = parent;
end
addpath(root);
cd(root);
end

function restore(folder, searchPath)
cd(folder);
path(searchPath);
end
