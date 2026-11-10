create temp table widget_import (record jsonb);
\copy widget_import (record) from 'widget.ndjson' with (format csv, quote e'\x01', delimiter e'\x02')
