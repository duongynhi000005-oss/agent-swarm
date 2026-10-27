-- Optional per-pool persistent cache volume configuration ({ "mountPath": "/cache" }).
ALTER TABLE runtime_pools ADD COLUMN cache TEXT;
