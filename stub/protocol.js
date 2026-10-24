// Generated from stub/protocol.json.
(function(root) {
    const protocol = {
  "name": "esp-io-rpc",
  "version": {
    "major": 1,
    "minor": 1
  },
  "byteOrder": "little",
  "framing": "SLIP",
  "maxPacketLength": 1024,
  "maxRegisterDelayUs": 100000,
  "buildVersion": "0.2.0",
  "header": [
    [
      "magic",
      "u8",
      4
    ],
    [
      "length",
      "u32"
    ]
  ],
  "status": {
    "OK": 0,
    "UNSUPPORTED": 1,
    "BAD_LENGTH": 2,
    "BAD_ARGUMENT": 3,
    "TIMEOUT": 4,
    "IO_ERROR": 5
  },
  "operations": {
    "CONFIGURE": 1,
    "TRANSFER": 2,
    "RELEASE": 3
  },
  "identityFlags": {
    "MAC_VALID": 1,
    "FLASH_ID_VALID": 2
  },
  "packets": {
    "sync": {
      "magic": "SYNC",
      "response": "identity",
      "fields": [],
      "offsets": {},
      "size": 8
    },
    "identity": {
      "magic": "IDEN",
      "fields": [
        [
          "protocol_major",
          "u16"
        ],
        [
          "protocol_minor",
          "u16"
        ],
        [
          "max_packet_length",
          "u32"
        ],
        [
          "capabilities",
          "u32"
        ],
        [
          "flags",
          "u32"
        ],
        [
          "flash_jedec_id",
          "u32"
        ],
        [
          "reset_reason",
          "u32"
        ],
        [
          "mac",
          "u8",
          6
        ],
        [
          "cpu_cores",
          "u8"
        ],
        [
          "transport",
          "u8"
        ],
        [
          "chip",
          "char",
          16
        ],
        [
          "cpu",
          "char",
          16
        ],
        [
          "build",
          "char",
          32
        ],
        [
          "idf",
          "char",
          16
        ]
      ],
      "offsets": {
        "protocol_major": 8,
        "protocol_minor": 10,
        "max_packet_length": 12,
        "capabilities": 16,
        "flags": 20,
        "flash_jedec_id": 24,
        "reset_reason": 28,
        "mac": 32,
        "cpu_cores": 38,
        "transport": 39,
        "chip": 40,
        "cpu": 56,
        "build": 72,
        "idf": 104
      },
      "size": 120
    },
    "error": {
      "magic": "ERRO",
      "fields": [
        [
          "request_magic",
          "char",
          4
        ],
        [
          "status",
          "u32"
        ]
      ],
      "offsets": {
        "request_magic": 8,
        "status": 12
      },
      "size": 16
    },
    "register_command": {
      "magic": "REGC",
      "response": "register_response",
      "fields": [
        [
          "operation",
          "u32"
        ],
        [
          "address",
          "u32"
        ],
        [
          "value",
          "u32"
        ],
        [
          "mask",
          "u32"
        ],
        [
          "delay_us",
          "u32"
        ]
      ],
      "offsets": {
        "operation": 8,
        "address": 12,
        "value": 16,
        "mask": 20,
        "delay_us": 24
      },
      "size": 28
    },
    "register_response": {
      "magic": "REGR",
      "fields": [
        [
          "status",
          "u32"
        ],
        [
          "value",
          "u32"
        ]
      ],
      "offsets": {
        "status": 8,
        "value": 12
      },
      "size": 16
    },
    "module_command": {
      "fields": [
        [
          "operation",
          "u16"
        ],
        [
          "port",
          "u16"
        ],
        [
          "timeout_us",
          "u32"
        ]
      ],
      "trailing": "Module-specific configuration or transfer bytes; reserved until implemented.",
      "offsets": {
        "operation": 8,
        "port": 10,
        "timeout_us": 12
      },
      "size": 16
    },
    "module_response": {
      "fields": [
        [
          "status",
          "u32"
        ],
        [
          "operation",
          "u16"
        ],
        [
          "port",
          "u16"
        ]
      ],
      "trailing": "Module-specific result bytes; empty for UNSUPPORTED.",
      "offsets": {
        "status": 8,
        "operation": 12,
        "port": 14
      },
      "size": 16
    },
    "sdmmc_command": {
      "magic": "SDMC",
      "response": "sdmmc_response",
      "fields": [
        [
          "operation",
          "u16"
        ],
        [
          "port",
          "u16"
        ],
        [
          "timeout_us",
          "u32"
        ],
        [
          "command",
          "u16"
        ],
        [
          "response_type",
          "u16"
        ],
        [
          "argument",
          "u32"
        ],
        [
          "data_bytes",
          "u16"
        ],
        [
          "application",
          "u16"
        ]
      ],
      "offsets": {
        "operation": 8,
        "port": 10,
        "timeout_us": 12,
        "command": 16,
        "response_type": 18,
        "argument": 20,
        "data_bytes": 24,
        "application": 26
      },
      "size": 28
    },
    "sdmmc_response": {
      "magic": "SDMR",
      "fields": [
        [
          "status",
          "u32"
        ],
        [
          "operation",
          "u16"
        ],
        [
          "port",
          "u16"
        ],
        [
          "command",
          "u16"
        ],
        [
          "response_type",
          "u16"
        ],
        [
          "argument",
          "u32"
        ],
        [
          "sd_error",
          "u32"
        ],
        [
          "events",
          "u32"
        ],
        [
          "data_events",
          "u32"
        ],
        [
          "transferred",
          "u32"
        ],
        [
          "descriptor",
          "u32"
        ],
        [
          "dma_status",
          "u32"
        ],
        [
          "response0",
          "u32"
        ],
        [
          "response1",
          "u32"
        ],
        [
          "response2",
          "u32"
        ],
        [
          "response3",
          "u32"
        ]
      ],
      "trailing": "Exactly 512 sector bytes only after a successful CMD17; otherwise empty.",
      "offsets": {
        "status": 8,
        "operation": 12,
        "port": 14,
        "command": 16,
        "response_type": 18,
        "argument": 20,
        "sd_error": 24,
        "events": 28,
        "data_events": 32,
        "transferred": 36,
        "descriptor": 40,
        "dma_status": 44,
        "response0": 48,
        "response1": 52,
        "response2": 56,
        "response3": 60
      },
      "size": 64
    }
  },
  "registerOperations": {
    "READ": 0,
    "WRITE": 1
  },
  "sdmmcResponseTypes": {
    "NONE": 0,
    "R1": 1,
    "R1B": 2,
    "R2": 3,
    "R3": 4,
    "R6": 5,
    "R7": 6
  },
  "sdmmcErrors": {
    "NONE": 0,
    "RESPONSE_TIMEOUT": 1,
    "COMMAND_TIMEOUT": 2,
    "RESPONSE_CRC": 3,
    "DATA_CRC": 4,
    "DATA_TIMEOUT": 5,
    "SHORT_DATA": 6,
    "CARD_STATUS": 7,
    "BUSY_TIMEOUT": 8,
    "DMA": 9,
    "HOST": 10,
    "NOT_CONFIGURED": 11
  },
  "capabilities": {
    "REGISTERS": 0,
    "I2C": 1,
    "SPI": 2,
    "SDMMC": 3,
    "RMT": 4,
    "PWM": 5,
    "UART": 6,
    "I2S": 7
  },
  "modules": {
    "I2C": {
      "command": "I2CC",
      "response": "I2CR"
    },
    "SPI": {
      "command": "SPIC",
      "response": "SPIR"
    },
    "SDMMC": {
      "command": "SDMC",
      "response": "SDMR"
    },
    "RMT": {
      "command": "RMTC",
      "response": "RMTR"
    },
    "PWM": {
      "command": "PWMC",
      "response": "PWMR"
    },
    "UART": {
      "command": "UARC",
      "response": "UARR"
    },
    "I2S": {
      "command": "I2SC",
      "response": "I2SR"
    }
  }
};
    if (typeof module === "object" && module.exports) module.exports = protocol;
    else (root.ESPIO ||= {}).rpcProtocol = protocol;
})(globalThis);
