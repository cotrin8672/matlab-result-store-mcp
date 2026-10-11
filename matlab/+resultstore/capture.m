function plot = capture(fig)
% Read rendered 2-D graphics, without translating the user's MATLAB function.
plot = struct('data', {{}}, 'layout', struct('autosize', true, ...
    'margin', struct('l', 0, 'r', 0, 't', 0, 'b', 0), 'hovermode', 'closest', ...
    'paper_bgcolor', 'white', 'plot_bgcolor', 'white', 'showlegend', false, 'annotations', {{}}));
axesList = flipud(findall(fig, 'Type', 'axes'));
if isempty(axesList), error('resultstore:UnsupportedGraphics', 'No supported Cartesian axes in this Plot.'); end
size = getpixelposition(fig);
for k = 1:numel(axesList)
    ax = axesList(k);
    if ax.Visible == "off", continue; end
    if ~isequal(ax.View, [0 90])
        error('resultstore:UnsupportedGraphics', 'Live Plot supports 2-D axes; use exportPlot for 3-D graphics.');
    end
    position = getpixelposition(ax, true);
    position = position ./ [size(3:4) size(3:4)];
    suffix = string(k); if k == 1, suffix = ""; end
    xref = "x" + suffix; yref = "y" + suffix;
    plot.layout.("xaxis" + suffix) = axisSpec(ax, 'X', position([1 3]), yref);
    plot.layout.("yaxis" + suffix) = axisSpec(ax, 'Y', position([2 4]), xref);
    title = label(ax.Title);
    if title ~= ""
        plot.layout.annotations{end + 1} = struct('text', title, 'showarrow', false, ...
            'xref', 'paper', 'yref', 'paper', 'x', position(1) + position(3)/2, ...
            'y', position(2) + position(4), 'xanchor', 'center', 'yanchor', 'bottom');
    end
    legendName = "legend" + suffix;
    legend = ax.Legend;
    if ~isempty(legend) && legend.Visible == "on"
        plot.layout.showlegend = true;
        north = ~contains(string(legend.Location), 'south');
        west = contains(string(legend.Location), 'west');
        plot.layout.(legendName) = struct('x', position(1) + (~west)*position(3), ...
            'y', position(2) + north*position(4), 'xanchor', choose(west, 'left', 'right'), ...
            'yanchor', choose(north, 'top', 'bottom'), 'font', struct('size', ax.FontSize));
    end
    children = flipud(ax.Children);
    for j = 1:numel(children)
        child = children(j);
        if child.Visible == "off", continue; end
        trace = struct('type', 'scatter', 'xaxis', xref, 'yaxis', yref, ...
            'showlegend', ~isempty(legend) && legend.Visible == "on" && child.HandleVisibility ~= "off", ...
            'legend', legendName);
        switch string(child.Type)
            case "line"
                trace.x = double(child.XData(:).'); trace.y = double(child.YData(:).');
                trace.name = label(child);
                trace.mode = 'lines';
                if child.LineStyle == "none", trace.mode = 'markers';
                elseif child.Marker ~= "none", trace.mode = 'lines+markers'; end
                trace.line = struct('color', color(child.Color), 'width', child.LineWidth, 'dash', dash(child.LineStyle));
                trace.marker = struct('color', color(child.Color), 'size', child.MarkerSize, 'symbol', marker(child.Marker));
            case "patch"
                if ~isvector(child.XData) || ~isvector(child.YData) || ~isnumeric(child.FaceColor)
                    error('resultstore:UnsupportedGraphics', 'Live Plot supports a numeric-color polygon patch; use exportPlot for other patches.');
                end
                trace.x = double(child.XData(:).'); trace.y = double(child.YData(:).');
                trace.name = label(child); trace.mode = 'lines'; trace.fill = 'toself';
                trace.fillcolor = color(child.FaceColor, child.FaceAlpha);
                trace.line = struct('width', 0);
                if isnumeric(child.EdgeColor), trace.line = struct('color', color(child.EdgeColor), 'width', child.LineWidth); end
            case "constantline"
                if child.InterceptAxis == "x"
                    trace.x = [child.Value child.Value]; trace.y = ax.YLim;
                else
                    trace.x = ax.XLim; trace.y = [child.Value child.Value];
                end
                trace.name = label(child); trace.mode = 'lines';
                trace.line = struct('color', color(child.Color), 'width', child.LineWidth, 'dash', dash(child.LineStyle));
            otherwise
                error('resultstore:UnsupportedGraphics', 'Unsupported live graphics object: %s. Use exportPlot for this Plot.', child.Type);
        end
        plot.data{end + 1} = trace;
    end
end
titles = findall(fig, 'Type', 'subplottext');
layouts = findall(fig, 'Type', 'tiledlayout');
for layout = layouts.'
    if strlength(label(layout.Title)) > 0, titles = [titles; layout.Title]; end
end
if ~isempty(titles)
    plot.layout.title = struct('text', label(titles(1)), 'x', .5, 'y', .98, 'yanchor', 'top');
end
end

function value = axisSpec(ax, direction, domain, anchor)
limits = ax.([direction 'Lim']);
scale = string(ax.([direction 'Scale']));
if scale == "log", limits = log10(limits); end
if ax.([direction 'Dir']) == "reverse", limits = fliplr(limits); end
value = struct('domain', max(0, min(1, [domain(1), sum(domain)])), 'anchor', anchor, ...
    'range', limits, 'type', scale, 'zeroline', false, 'showline', true, 'mirror', ax.Box == "on", ...
    'showgrid', ax.([direction 'Grid']) == "on", 'title', struct('text', label(ax.([direction 'Label']))), ...
    'tickfont', struct('size', ax.FontSize), 'linecolor', color(ax.([direction 'Color'])));
if ax.([direction 'TickLabelMode']) == "manual"
    value.tickmode = 'array'; value.tickvals = ax.([direction 'Tick']);
    value.ticktext = cellstr(string(ax.([direction 'TickLabel'])));
end
if value.type == "linear", value.type = 'linear'; end
end

function text = label(object)
if isprop(object, 'String'), raw = object.String; else, raw = object.DisplayName; end
lines = string(raw);
text = join(lines(:), "<br>");
text = replace(text, ["\alpha", "\Gamma", "\pi", "\theta", "\Delta", "\Omega", "\mu"], ...
    ["α", "Γ", "π", "θ", "Δ", "Ω", "μ"]);
text = regexprep(text, '_\{([^}]+)\}', '<sub>$1</sub>');
text = regexprep(text, '\^\{([^}]+)\}', '<sup>$1</sup>');
text = regexprep(text, '\^([0-9]+)', '<sup>$1</sup>');
end

function value = color(rgb, alpha)
if nargin < 2, alpha = 1; end
value = sprintf('rgba(%g,%g,%g,%g)', round(rgb(1)*255), round(rgb(2)*255), round(rgb(3)*255), alpha);
end

function value = dash(style)
switch string(style)
    case "--", value = 'dash';
    case ":", value = 'dot';
    case "-.", value = 'dashdot';
    otherwise, value = 'solid';
end
end

function value = marker(style)
styles = ["none", ".", "o", "+", "x", "*", "s", "square", "d", "diamond", "^", "v", ">", "<", "p", "pentagram", "h", "hexagram"];
symbols = ["circle", "circle", "circle", "cross", "x", "asterisk", "square", "square", "diamond", "diamond", "triangle-up", "triangle-down", "triangle-right", "triangle-left", "pentagon", "pentagon", "hexagon", "hexagon"];
index = find(styles == string(style), 1);
if isempty(index), error('resultstore:UnsupportedGraphics', 'Unsupported marker: %s.', style); end
value = symbols(index);
end

function value = choose(condition, yes, no)
if condition, value = yes; else, value = no; end
end
