function worker(root, common)
% One shared Plot process, independent of interactive calculation sessions.
arguments
    root (1, 1) string
    common (1, 1) string = ""
end
if strlength(common) > 0, addpath(common); end
addpath(root);
if isempty(which('store.loadSchemes'))
    error('resultstore:MissingFramework', 'Add the Result Store common folder to MATLABPATH.');
end
connection = resultstore.connect(root, "worker.json");
cleanup = onCleanup(@() delete(connection));
while isvalid(connection) && connection.Running == "on"
    pause(.1);
end
end
