function connection = connect(root, descriptorName)
% Serve registered Plots from this MATLAB session; no engine is launched.
arguments
    root (1, 1) string = "."
    descriptorName (1, 1) string = "live.json"
end
root = string(java.io.File(char(root)).getCanonicalPath());
resultstore.exportCatalog(root);
name = "Result Store: " + root;
connection = timerfindall('Name', name);
if ~isempty(connection) && connection(1).Running == "on"
    connection = connection(1);
    return
end
if ~isempty(connection), delete(connection); end
token = char(java.util.UUID.randomUUID());
folder = fullfile(string(tempdir), "result-store-" + token);
mkdir(folder);
descriptor = fullfile(root, "results", "web", descriptorName);
writeJson(descriptor, struct('version', 1, 'folder', folder, 'token', token, 'pid', feature('getpid'), 'jobs', true));
fig = [];
activeFunction = [];
activePayload = "";
activeInputs = strings(1, 0);
activeArgs = {};
activeScheme = "";
activeRow = uint64(0);
previous = [];
revision = "";
renderedKey = "";
connection = timer('Name', name, 'ExecutionMode', 'fixedSpacing', 'Period', .02, ...
    'TimerFcn', @receive, 'StopFcn', @disconnect);
start(connection);

    function receive(~, ~)
        resultstore.jobs("poll", struct());
        files = dir(fullfile(folder, '*.request.json'));
        if isempty(files), return; end
        requestFile = fullfile(folder, files(1).name);
        responseFile = replace(requestFile, '.request.json', '.response.json');
        try
            request = jsondecode(fileread(requestFile));
            if ~strcmp(request.token, token) || request.expires < posixtime(datetime('now', 'TimeZone', 'UTC')) * 1000
                delete(requestFile);
                return
            end
            if isfield(request, 'operation') && strcmp(request.operation, 'catalog')
                resultstore.exportCatalog(root);
                delete(requestFile);
                writeJson(responseFile, struct());
                return
            end
            if isfield(request, 'operation') && strcmp(request.operation, 'job')
                reply = resultstore.jobs("submit", request);
                delete(requestFile);
                writeJson(responseFile, reply);
                return
            end
            if isempty(regexp(request.row_id, '^[1-9][0-9]{0,18}$', 'once'))
                error('resultstore:InvalidRowId', 'Invalid RowId.');
            end
            rowId = uint64(0);
            for digit = char(request.row_id), rowId = rowId * uint64(10) + uint64(digit - '0'); end
            if rowId > uint64(intmax('int64')), error('resultstore:InvalidRowId', 'RowId exceeds SQLite range.'); end
            if request.refresh, rehash; end
            scheme = store.loadScheme(string(request.scheme), root);
            validateattributes(request.plot_index, {'double'}, {'scalar', 'integer', 'positive', '<=', numel(scheme.plots)});
            spec = scheme.plots(request.plot_index);
            payload = store.getRecordPath(scheme.id, rowId, root);
            loadTime = tic;
            if request.refresh || payload ~= activePayload || activeScheme ~= scheme.id || activeRow ~= rowId || ~isequal(spec.Inputs, activeInputs)
                activeArgs = store.getValue(scheme.id, rowId, spec.Inputs, root);
                activePayload = payload;
                activeInputs = spec.Inputs;
                activeScheme = scheme.id;
                activeRow = rowId;
            end
            timings.load_ms = toc(loadTime) * 1000;
            drawTime = tic;
            key = scheme.id + "/" + string(rowId) + "/" + request.plot_index + ":" + payload;
            needsDraw = request.refresh || key ~= renderedKey || ~isequal(activeFunction, spec.Function);
            if isempty(fig) || ~isgraphics(fig)
                fig = figure('Visible', 'off', 'HandleVisibility', 'off', 'IntegerHandle', 'off', ...
                    'Position', [100 100 1100 800], 'Tag', 'ResultStoreLive');
                activeFunction = [];
                needsDraw = true;
            end
            if needsDraw
                renderedKey = "";
                if ~isequal(activeFunction, spec.Function), clf(fig); end
                spec.Function(fig, activeArgs{:});
                activeFunction = spec.Function;
                drawnow limitrate nocallbacks;
            end
            timings.draw_ms = toc(drawTime) * 1000;
            captureTime = tic;
            if needsDraw, plot = resultstore.capture(fig); else, plot = previous; end
            plot.layout.uirevision = char(scheme.id + "/" + request.plot_index);
            nextRevision = string(java.util.UUID.randomUUID());
            update = resultstore.plotUpdate(previous, plot, revision, nextRevision, string(request.known_revision));
            previous = plot;
            revision = nextRevision;
            renderedKey = key;
            timings.capture_ms = toc(captureTime) * 1000;
            reply = struct('payload', payload, 'plot_name', spec.Name, 'update', update, 'timings', timings);
            if request.preview
                imageFile = fullfile(folder, 'preview.png');
                frame = getframe(fig);
                imwrite(frame.cdata, imageFile);
                fid = fopen(imageFile, 'r');
                cleanup = onCleanup(@() fclose(fid));
                reply.preview = matlab.net.base64encode(fread(fid, Inf, '*uint8'));
                clear cleanup
                delete(imageFile);
            end
        catch exception
            reply = struct('error', exception.message);
        end
        if isfile(requestFile), delete(requestFile); end
        writeJson(responseFile, reply);
    end

    function disconnect(~, ~)
        if ~isempty(fig) && isgraphics(fig), close(fig); end
        if isfile(descriptor)
            saved = jsondecode(fileread(descriptor));
            if strcmp(saved.token, token), delete(descriptor); end
        end
    end
end

function writeJson(file, value)
temporary = file + ".tmp";
fid = fopen(temporary, 'w', 'n', 'UTF-8');
if fid < 0, error('resultstore:WriteFailed', 'Cannot write %s.', temporary); end
cleanup = onCleanup(@() fclose(fid));
fprintf(fid, '%s', jsonencode(value));
clear cleanup
movefile(temporary, file, 'f');
end
