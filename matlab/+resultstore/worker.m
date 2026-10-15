function worker(root, common, descriptor)
% One shared Plot process, independent of interactive calculation sessions.
arguments
    root (1, 1) string
    common (1, 1) string = ""
    descriptor (1, 1) string = fullfile(string(tempdir), "result-store-worker-shared", "worker.json")
end
if strlength(common) > 0, addpath(common); end
if isempty(which('store.loadSchemes'))
    error('resultstore:MissingFramework', 'Add the Result Store common folder to MATLABPATH.');
end
connection = resultstore.connect(root, "worker.json", descriptor);
cleanup = onCleanup(@() delete(connection));
while isvalid(connection) && connection.Running == "on"
    pause(.1);
end
end
