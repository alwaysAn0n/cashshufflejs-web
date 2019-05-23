module.exports = {
  "nested": {
    "Signed": {
      "fields": {
        "packet": {
          "type": "Packet",
          "id": 1
        },
        "signature": {
          "type": "Signature",
          "id": 2
        }
      }
    },
    "Packet": {
      "fields": {
        "session": {
          "type": "bytes",
          "id": 1
        },
        "number": {
          "type": "uint32",
          "id": 2
        },
        "fromKey": {
          "type": "VerificationKey",
          "id": 3
        },
        "toKey": {
          "type": "VerificationKey",
          "id": 4
        },
        "phase": {
          "type": "Phase",
          "id": 5
        },
        "message": {
          "type": "Message",
          "id": 6
        },
        "registration": {
          "type": "Registration",
          "id": 7
        }
      }
    },
    "Phase": {
      "values": {
        "NONE": 0,
        "ANNOUNCEMENT": 1,
        "SHUFFLE": 2,
        "BROADCAST": 3,
        "EQUIVOCATION_CHECK": 4,
        "SIGNING": 5,
        "VERIFICATION_AND_SUBMISSION": 6,
        "BLAME": 7
      }
    },
    "ShuffleType": {
      "values": {
        "DEFAULT": 0,
        "DUST": 1
      }
    },
    "Coins": {
      "fields": {
        "coins": {
          "rule": "repeated",
          "type": "string",
          "id": 1
        }
      }
    },
    "Signatures": {
      "fields": {
        "utxo": {
          "type": "string",
          "id": 1
        },
        "signature": {
          "type": "Signature",
          "id": 2
        }
      }
    },
    "Message": {
      "fields": {
        "address": {
          "type": "Address",
          "id": 1
        },
        "key": {
          "type": "EncryptionKey",
          "id": 2
        },
        "hash": {
          "type": "Hash",
          "id": 3
        },
        "signatures": {
          "rule": "repeated",
          "type": "Signatures",
          "id": 4
        },
        "str": {
          "type": "string",
          "id": 5
        },
        "blame": {
          "type": "Blame",
          "id": 6
        },
        "inputs": {
          "keyType": "string",
          "type": "Coins",
          "id": 7
        }
      }
    },
    "Address": {
      "fields": {
        "address": {
          "type": "string",
          "id": 1
        }
      }
    },
    "Registration": {
      "fields": {
        "amount": {
          "type": "uint64",
          "id": 1
        },
        "type": {
          "type": "ShuffleType",
          "id": 2
        },
        "version": {
          "type": "uint64",
          "id": 3
        }
      }
    },
    "VerificationKey": {
      "fields": {
        "key": {
          "type": "string",
          "id": 1
        }
      }
    },
    "EncryptionKey": {
      "fields": {
        "key": {
          "type": "string",
          "id": 1
        }
      }
    },
    "DecryptionKey": {
      "fields": {
        "key": {
          "type": "string",
          "id": 1
        },
        "public": {
          "type": "string",
          "id": 2
        }
      }
    },
    "Hash": {
      "fields": {
        "hash": {
          "type": "bytes",
          "id": 1
        }
      }
    },
    "Signature": {
      "fields": {
        "signature": {
          "type": "bytes",
          "id": 1
        }
      }
    },
    "Transaction": {
      "fields": {
        "transaction": {
          "type": "bytes",
          "id": 1
        }
      }
    },
    "Blame": {
      "fields": {
        "reason": {
          "type": "Reason",
          "id": 1
        },
        "accused": {
          "type": "VerificationKey",
          "id": 2
        },
        "key": {
          "type": "DecryptionKey",
          "id": 3
        },
        "transaction": {
          "type": "Transaction",
          "id": 4
        },
        "invalid": {
          "type": "Invalid",
          "id": 5
        },
        "packets": {
          "type": "Packets",
          "id": 6
        }
      }
    },
    "Reason": {
      "values": {
        "INSUFFICIENTFUNDS": 0,
        "DOUBLESPEND": 1,
        "EQUIVOCATIONFAILURE": 2,
        "SHUFFLEFAILURE": 3,
        "SHUFFLEANDEQUIVOCATIONFAILURE": 4,
        "INVALIDSIGNATURE": 5,
        "MISSINGOUTPUT": 6,
        "LIAR": 7,
        "INVALIDFORMAT": 8
      }
    },
    "Invalid": {
      "fields": {
        "invalid": {
          "type": "bytes",
          "id": 1
        }
      }
    },
    "Inputs": {
      "fields": {
        "address": {
          "type": "string",
          "id": 1
        },
        "coins": {
          "rule": "repeated",
          "type": "string",
          "id": 2
        }
      }
    },
    "Packets": {
      "fields": {
        "packet": {
          "rule": "repeated",
          "type": "Signed",
          "id": 1
        }
      }
    }
  }
};
