<?php
$names = collect(['Ada', 'Grace']);
// ^?
$upper = $names->map(fn ($name) => strtoupper($name));
// ^?
