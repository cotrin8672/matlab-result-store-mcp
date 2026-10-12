function reply = jobs(operation, request)
% Futures keep execution off the Plot worker's main thread.
persistent pending lastPoll
if isempty(pending), pending = containers.Map('KeyType', 'char', 'ValueType', 'any'); end
reply = struct();
if operation == "submit"
    id = char(request.job_id);
    if isempty(regexp(id, '^[a-f0-9-]{36}$', 'once'))
        error('resultstore:InvalidJob', 'Invalid Job ID.');
    end
    folder = string(java.io.File(request.folder).getCanonicalPath());
    parent = fileparts(folder);
    [~, parentName] = fileparts(parent);
    if ~startsWith(parentName, 'result-store-jobs-') || ...
            string(java.io.File(fileparts(parent)).getCanonicalPath()) ~= string(java.io.File(tempdir).getCanonicalPath()) || ...
            folder ~= fullfile(parent, id)
        error('resultstore:InvalidJob', 'Invalid Job folder.');
    end
    if isKey(pending, id), return; end
    job = jsondecode(fileread(fullfile(folder, 'request.json')));
    if ~strcmp(job.job_id, id) || ~ismember(string(job.backend), ["background", "worker"])
        error('resultstore:InvalidJob', 'Invalid Job request.');
    end
    statusFile = fullfile(folder, 'status.json');
    if isfile(statusFile), return; end
    status = struct('state', 'queued', 'pid', feature('getpid'), 'updated_at', nowUtc());
    writeJson(statusFile, status);
    pending(id) = struct('folder', folder, 'job', job, 'future', [], 'status', status, 'diary', '', 'cancelled', false);
    return
end
if ~isempty(lastPoll) && toc(lastPoll) < .25, return; end
lastPoll = tic;
ids = keys(pending);
for k = 1:numel(ids)
    id = ids{k};
    item = pending(id);
    try
        if isfile(fullfile(item.folder, 'cancel'))
            if isempty(item.future)
                item.status.state = 'cancelled';
            elseif ~strcmp(item.future.State, 'finished')
                cancel(item.future);
                item.cancelled = true;
            end
        elseif isempty(item.future)
            addpath(item.folder);
            rehash;
            if strcmp(item.job.backend, 'background')
                pool = backgroundPool;
            else
                pool = gcp('nocreate');
                if isempty(pool), pool = parpool('Processes', 1); end
                if ~isa(pool, 'parallel.ProcessPool')
                    error('resultstore:WrongPool', 'The MCP MATLAB must use a process pool for run_matlab_worker.');
                end
            end
            item.future = parfeval(pool, str2func(item.job.function_name), 1);
        end
        if ~isempty(item.future)
            diary = char(item.future.Diary);
            if ~strcmp(diary, item.diary)
                writeText(fullfile(item.folder, 'stdout.txt'), diary);
                item.diary = diary;
            end
            if strcmp(item.future.State, 'finished')
                if item.cancelled
                    item.status.state = 'cancelled';
                else
                    outputs = fetchOutputs(item.future);
                    save(fullfile(item.folder, 'outputs.mat'), '-struct', 'outputs', '-v7.3');
                    item.status.state = 'succeeded';
                end
            else
                item.status.state = char(item.future.State);
            end
        end
    catch exception
        while contains(exception.identifier, 'parallel:') && numel(exception.cause) == 1
            exception = exception.cause{1};
        end
        item.status.state = 'failed';
        item.status.error = struct('identifier', exception.identifier, 'message', exception.message, 'stack', exception.stack);
    end
    terminal = ismember(item.status.state, {'succeeded', 'failed', 'cancelled'});
    if terminal, item.status.finished_at = nowUtc(); end
    if ~isequal(item.status, pending(id).status)
        item.status.updated_at = nowUtc();
        writeJson(fullfile(item.folder, 'status.json'), item.status);
    end
    if terminal
        if ~isempty(item.future), delete(item.future); end
        if contains(path, char(item.folder)), rmpath(item.folder); end
        remove(pending, id);
    else
        pending(id) = item;
    end
end
end

function value = nowUtc()
value = char(datetime('now', 'TimeZone', 'UTC', 'Format', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"));
end

function writeJson(file, value)
writeText(file, jsonencode(value));
end

function writeText(file, value)
temporary = file + ".tmp";
fid = fopen(temporary, 'w', 'n', 'UTF-8');
if fid < 0, error('resultstore:WriteFailed', 'Cannot write %s.', temporary); end
cleanup = onCleanup(@() fclose(fid));
fprintf(fid, '%s', value);
clear cleanup
movefile(temporary, file, 'f');
end
