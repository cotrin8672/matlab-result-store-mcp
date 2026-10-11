function update = plotUpdate(previous, current, revision, nextRevision, knownRevision)
% Transfer only changed trace fields and layout entries when the base matches.
update = struct('revision', nextRevision);
if isempty(previous) || knownRevision ~= revision || numel(previous.data) ~= numel(current.data)
    update.plot = current;
    return
end
update.base_revision = revision;
update.traces = {};
for k = 1:numel(current.data)
    before = previous.data{k}; after = current.data{k};
    if ~isequal(sort(fieldnames(before)), sort(fieldnames(after)))
        update = struct('revision', nextRevision, 'plot', current);
        return
    end
    values = struct;
    for field = string(fieldnames(after)).'
        if ~isequaln(before.(field), after.(field)), values.(field) = after.(field); end
    end
    if ~isempty(fieldnames(values))
        update.traces{end + 1} = struct('index', k - 1, 'values', values);
    end
end
if ~isequal(sort(fieldnames(previous.layout)), sort(fieldnames(current.layout)))
    update = struct('revision', nextRevision, 'plot', current);
    return
end
update.layout = struct;
for field = string(fieldnames(current.layout)).'
    if ~isequaln(previous.layout.(field), current.layout.(field))
        update.layout.(field) = current.layout.(field);
    end
end
end
