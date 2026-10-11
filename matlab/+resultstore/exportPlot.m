function folder = exportPlot(id, rowId, plotIndex, root)
% Convert an existing registered Plot with fig2plotly in this MATLAB session.
arguments
    id (1, 1) string
    rowId (1, 1) uint64
    plotIndex (1, 1) double {mustBeInteger, mustBePositive} = 1
    root (1, 1) string = "."
end
if isempty(which('fig2plotly'))
    error("resultstore:PlotlyMissing", "Add plotly_matlab to the MATLAB path before exporting.");
end
repo = fileparts(fileparts(fileparts(mfilename('fullpath'))));
modules = fullfile(repo, "node_modules");
plotlyJs = fullfile(modules, "plotly.js-dist-min", "plotly.min.js");
mathjaxJs = fullfile(modules, "mathjax", "es5", "tex-svg-full.js");
if ~isfile(plotlyJs) || ~isfile(mathjaxJs)
    error("resultstore:PlotlyAssetsMissing", "Run pnpm install in %s first.", repo);
end
scheme = store.loadScheme(id, root);
if plotIndex > numel(scheme.plots)
    error("resultstore:PlotNotFound", "Scheme %s has no Plot at index %d.", id, plotIndex);
end
spec = scheme.plots(plotIndex);
payload = store.getRecordPath(id, rowId, root);
inputs = store.getValue(id, rowId, spec.Inputs, root);
folder = fullfile(root, "results", "web", id, string(rowId), string(plotIndex));
if ~isfolder(folder), mkdir(folder); end

fig = figure('Visible', 'off', 'Position', [100 100 1100 800]);
cleanupFigure = onCleanup(@() close(fig));
spec.Function(fig, inputs{:});
drawnow;
print(fig, char(fullfile(folder, "preview.png")), '-dpng', '-r100');
% Only convert the Figure. Bundle browser assets locally, without Plotly login.
p = fig2plotly(fig, 'offline', true, 'open', false, 'writefile', false, ...
    'visible', 'off', 'strip', false);
title = findall(fig, 'Type', 'subplottext');
if ~isempty(title)
    text = parseString(char(join(string(title(1).String), " ")), title(1).Interpreter);
    p.layout.title = struct('text', text, 'x', 0.5, 'y', 0.95, 'yanchor', 'top');
    if isfield(p.layout, 'titlefont'), p.layout = rmfield(p.layout, 'titlefont'); end
end
plot = struct('data', {p.data}, 'layout', p.layout, 'frames', {p.frames});
writeText(fullfile(folder, "plot.json"), jsonencode(plot));

% fig2plotly emits a fixed-size fragment; this wrapper supplies offline assets
% and lets the converted plot follow the browser's available width.
encoded = strrep(jsonencode(plot), '<', '\u003c');
html = "<!doctype html><html lang=""ja""><meta charset=""utf-8"">" + ...
    "<meta name=""viewport"" content=""width=device-width,initial-scale=1"">" + ...
    "<title>" + id + "/" + string(rowId) + "</title>" + ...
    "<style>html,body{margin:0;width:100%;height:100%}#plot{width:100%;height:100vh}</style>" + ...
    "<script>window.MathJax={svg:{fontCache:'local'},startup:{typeset:false}};</script>" + ...
    "<script>" + string(fileread(mathjaxJs)) + "</script>" + ...
    "<script>" + string(fileread(plotlyJs)) + "</script>" + ...
    "<div id=""plot""></div><script>const plot=" + encoded + ";" + ...
    "delete plot.layout.width;delete plot.layout.height;plot.layout.autosize=true;" + ...
    "MathJax.startup.promise.then(()=>Plotly.newPlot('plot',plot.data,plot.layout," + ...
    "{responsive:true,displaylogo:false,showLink:false}));</script></html>";
writeText(fullfile(folder, "plot.html"), html);
manifest = struct('version', 1, 'scheme', id, 'row_id', string(rowId), ...
    'plot_index', plotIndex, 'plot_name', spec.Name, 'payload', payload);
% Write export metadata after the browser artifacts are complete.
writeText(fullfile(folder, "manifest.json"), jsonencode(manifest));
resultstore.exportCatalog(root);
clear cleanupFigure p
end

function writeText(path, text)
fid = fopen(path, 'w', 'n', 'UTF-8');
cleanup = onCleanup(@() fclose(fid));
fprintf(fid, '%s', text);
end
