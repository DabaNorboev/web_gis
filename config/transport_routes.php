<?php

return [
    'version' => 1,
    'source' => 'User-provided screenshots of the transport route selector',
    'source_url' => null, // The exact page URL was not supplied with the screenshots.
    'captured_at' => '2026-10-10',
    'observed_at' => null,
    'routes' => [
        'bus' => ['2', '3', '5', '6', '7', '8', '9', '10', '11', '12', '14', '18', '18с', '19', '21', '22', '23', '26', '27', '30', '31', '33', '35', '36', '37', '38', '39', '40', '40а', '40с', '43', '49', '50', '52', '55', '56', '58', '59', '60', '61', '63', '64', '65', '66', '67', '69', '70', '71', '73', '77', '78', '80', '81', '83', '85', '87', '88', '90', '92', '94', '95', '98', '99'],
        'trolleybus' => ['4', '5', '6', '13', '15'],
        'tram' => ['2', '4', '5', '6', '7'],
    ],
    // An electric bus is a bus in the existing database taxonomy.
    'electric_bus_refs' => ['1'],
];
