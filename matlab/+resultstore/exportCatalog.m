function path = exportCatalog(root)
% Export registered Plot names without executing store.m or a solver.
arguments
    root (1, 1) string = "."
end
schemes = store.loadSchemes(root);
ids = keys(schemes);
entries = cell(1, numel(ids));
for k = 1:numel(ids)
    scheme = schemes(ids(k));
    plots = cell(1, numel(scheme.plots));
    for j = 1:numel(plots)
        spec = scheme.plots(j);
        plots{j} = struct('index', j, 'name', spec.Name, ...
            'inputs', {cellstr(spec.Inputs)});
    end
    entries{k} = struct('id', scheme.id, 'plots', {plots});
end
catalog = struct('version', 1, 'snapshot', string(store.backend("metadata", root)), ...
    'schemes', {entries});
folder = fullfile(root, "results", "web");
if ~isfolder(folder), mkdir(folder); end
path = fullfile(folder, "catalog.json");
temporary = path + "." + string(java.util.UUID.randomUUID()) + ".tmp";
fid = fopen(temporary, 'w', 'n', 'UTF-8');
cleanup = onCleanup(@() fclose(fid));
fprintf(fid, '%s', jsonencode(catalog));
clear cleanup
movefile(temporary, path, 'f');
end
