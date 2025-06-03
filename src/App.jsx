import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, Settings, Users, Hash, Zap } from 'lucide-react';

const App = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [partitions, setPartitions] = useState(3);
  const [consumers, setConsumers] = useState(2);
  const [consumerGroups, setConsumerGroups] = useState([
    { id: 'analytics-service', consumers: 2, color: '#10b981', filter: null },
    { id: 'billing-service', consumers: 1, color: '#3b82f6', filter: null },
    { id: 'account-001-processor', consumers: 1, color: '#f59e0b', filter: 'acc_001' }
  ]);
  const [messages, setMessages] = useState([]);
  const [partitionKey, setPartitionKey] = useState('account_id');
  const [partitionKeyTemplate, setPartitionKeyTemplate] = useState('account_id');
  const [messageFields, setMessageFields] = useState({
    account_id: ['acc_001', 'acc_002', 'acc_003', 'acc_004'],
    record_id: ['rec_101', 'rec_102', 'rec_103', 'rec_104', 'rec_105'],
    user_id: ['user_123', 'user_456', 'user_789'],
    region: ['us-east', 'us-west', 'eu-west'],
    event_type: ['login', 'purchase', 'view', 'logout']
  });
  const [consumerLag, setConsumerLag] = useState({});
  const [processingRate, setProcessingRate] = useState(0.8); // 80% of incoming messages processed
  const [isRebalancing, setIsRebalancing] = useState(false);
  const [partitionAssignments, setPartitionAssignments] = useState({});
  const [groupAssignments, setGroupAssignments] = useState({});
  const [groupOffsets, setGroupOffsets] = useState({}); // Track offsets per group per partition
  const [rebalanceStrategy, setRebalanceStrategy] = useState('range');
  const [previousAssignments, setPreviousAssignments] = useState({});
  const [throughputMetrics, setThroughputMetrics] = useState({
    produced: 0,
    consumed: 0,
    producedHistory: [],
    consumedHistory: [],
    partitionThroughput: {}
  });
  const [messageRate, setMessageRate] = useState(1); // messages per second
  const [showOrderingDemo, setShowOrderingDemo] = useState(false);
  const [globalMessageCounter, setGlobalMessageCounter] = useState(0);
  const intervalRef = useRef(null);

  // Message colors for different partition keys
  const getKeyColor = (key) => {
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash = hash & hash;
    }
    return colors[Math.abs(hash) % colors.length];
  };

  // Generate message with realistic fields
  const generateMessageData = () => {
    const data = {};
    Object.entries(messageFields).forEach(([field, values]) => {
      data[field] = values[Math.floor(Math.random() * values.length)];
    });
    return data;
  };

  // Extract partition key from message using template
  const extractPartitionKey = (messageData, template) => {
    try {
      // Replace field references with actual values
      let key = template;
      Object.entries(messageData).forEach(([field, value]) => {
        key = key.replace(new RegExp(`\\b${field}\\b`, 'g'), value);
      });
      
      // Handle expressions like account_id:record_id
      const processedKey = key.replace(/(\w+):(\w+)/g, (match, field1, field2) => {
        const val1 = messageData[field1] || field1;
        const val2 = messageData[field2] || field2;
        return `${val1}:${val2}`;
      });
      
      return processedKey;
    } catch (e) {
      return template; // Fallback to template if parsing fails
    }
  };

  // Simple hash function to determine partition
  const getPartition = (key) => {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash) % partitions;
  };

  // Generate a new message
  const generateMessage = () => {
    const messageData = generateMessageData();
    const key = extractPartitionKey(messageData, partitionKeyTemplate);
    const partition = getPartition(key);
    
    // Increment global counter for ordering demo
    const currentGlobalId = globalMessageCounter + 1;
    setGlobalMessageCounter(currentGlobalId);
    
    return {
      id: Date.now() + Math.random(),
      globalOrder: currentGlobalId, // Global order across all partitions
      offset: messages.filter(m => m.partition === partition).length, // Partition-specific offset
      key,
      messageData,
      partition,
      timestamp: Date.now(),
      color: getKeyColor(key),
      processedByGroups: {}, // Track which groups have processed this message
      processedAt: null // When this message was actually processed
    };
  };

  // Start/stop message generation
  useEffect(() => {
    if (isRunning) {
      intervalRef.current = setInterval(() => {
        const newMessages = [];
        const messagesToGenerate = Math.max(1, Math.round(messageRate));
        
        for (let i = 0; i < messagesToGenerate; i++) {
          newMessages.push(generateMessage());
        }
        
        setMessages(prev => [...prev, ...newMessages].slice(-100)); // Keep last 100 messages
        
        // Update throughput metrics
        setThroughputMetrics(prev => ({
          ...prev,
          produced: prev.produced + messagesToGenerate,
          producedHistory: [...prev.producedHistory, { 
            timestamp: Date.now(), 
            count: messagesToGenerate 
          }].slice(-60) // Keep last 60 seconds
        }));
      }, 1000 / Math.max(1, messageRate)); // Adjust interval based on rate
    } else {
      clearInterval(intervalRef.current);
    }

    return () => clearInterval(intervalRef.current);
  }, [isRunning, partitionKeyTemplate, partitions, messageRate]);

  // Auto-process messages with realistic lag per consumer group
  useEffect(() => {
    if (isRebalancing) return; // Don't process during rebalancing
    
    const processInterval = setInterval(() => {
      setMessages(prev => {
        const newMessages = [...prev];
        const lagData = {};
        const partitionProcessed = {};
        let totalProcessed = 0;

        // Process messages for each consumer group independently
        consumerGroups.forEach(group => {
          const groupAssignment = getConsumersForGroup(group.id);
          
          // Process messages per partition for this group
          for (let p = 0; p < partitions; p++) {
            if (groupAssignment[p] === undefined) continue;
            
            let partitionMessages = newMessages.filter(msg => 
              msg.partition === p && !msg.processedByGroups[group.id]
            );
            
            // Apply filter if group has one
            if (group.filter) {
              partitionMessages = partitionMessages.filter(msg => {
                // Check if partition key or any message field contains the filter value
                const keyMatches = msg.key && msg.key.includes(group.filter);
                const fieldMatches = Object.values(msg.messageData).some(value => 
                  String(value).includes(group.filter)
                );
                return keyMatches || fieldMatches;
              });
            }
            
            // Apply different processing rates per group (simulate different service speeds)
            const groupProcessingRate = group.id.includes('analytics') ? processingRate * 0.8 : // Analytics slower
                                      group.id.includes('billing') ? processingRate * 1.2 : // Billing faster
                                      group.filter ? processingRate * 1.5 : // Filtered groups process faster (less data)
                                      processingRate;
            
            const messagesToProcess = Math.floor(partitionMessages.length * groupProcessingRate);
            
            // Process oldest messages first for this group
            const sortedMessages = partitionMessages.sort((a, b) => a.timestamp - b.timestamp);
            for (let i = 0; i < messagesToProcess; i++) {
              const msgIndex = newMessages.findIndex(msg => msg.id === sortedMessages[i]?.id);
              if (msgIndex !== -1) {
                newMessages[msgIndex] = { 
                  ...newMessages[msgIndex], 
                  processedByGroups: {
                    ...newMessages[msgIndex].processedByGroups,
                    [group.id]: true
                  },
                  processedAt: newMessages[msgIndex].processedAt || Date.now()
                };
                
                // Update group offset for this partition
                setGroupOffsets(prevOffsets => ({
                  ...prevOffsets,
                  [group.id]: {
                    ...prevOffsets[group.id],
                    [p]: (prevOffsets[group.id]?.[p] || 0) + 1
                  }
                }));
              }
            }
            
            partitionProcessed[`${group.id}-${p}`] = messagesToProcess;
            if (group.id === consumerGroups[0].id) {
              totalProcessed += messagesToProcess;
              
              // Calculate lag for display (using first group)
              const unprocessedCount = partitionMessages.length - messagesToProcess;
              const oldestUnprocessed = sortedMessages.slice(messagesToProcess)[0];
              lagData[p] = {
                count: unprocessedCount,
                oldestTimestamp: oldestUnprocessed?.timestamp || null,
                lagMs: oldestUnprocessed ? Date.now() - oldestUnprocessed.timestamp : 0
              };
            }
          }
        });
        
        setConsumerLag(lagData);
        
        // Update throughput metrics
        setThroughputMetrics(prev => ({
          ...prev,
          consumed: prev.consumed + totalProcessed,
          consumedHistory: [...prev.consumedHistory, { 
            timestamp: Date.now(), 
            count: totalProcessed 
          }].slice(-60),
          partitionThroughput: {
            ...prev.partitionThroughput,
            ...Object.fromEntries(
              Object.entries(partitionProcessed)
                .filter(([key]) => key.startsWith(consumerGroups[0]?.id || ''))
                .map(([key, count]) => {
                  const partition = key.split('-')[1];
                  return [
                    partition, 
                    [...(prev.partitionThroughput[partition] || []), { timestamp: Date.now(), count }].slice(-20)
                  ];
                })
            )
          }
        }));
        
        return newMessages;
      });
    }, 1000);

    return () => clearInterval(processInterval);
  }, [partitions, processingRate, isRebalancing, consumerGroups]);

  // Clean up old messages
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      setMessages(prev => prev.filter(msg => Date.now() - msg.timestamp < 10000));
    }, 2000);

    return () => clearInterval(cleanupInterval);
  }, []);

  const getPartitionMessages = (partitionId) => {
    return messages.filter(msg => msg.partition === partitionId);
  };

  // Rebalancing strategies
  const calculateAssignments = (strategy, numPartitions, numConsumers, prevAssignments = {}) => {
    const assignments = {};
    
    switch (strategy) {
      case 'range':
        // Range: Divide partitions into ranges per consumer
        const partitionsPerConsumer = Math.floor(numPartitions / numConsumers);
        const extraPartitions = numPartitions % numConsumers;
        
        let partitionIndex = 0;
        for (let c = 0; c < numConsumers; c++) {
          const partitionsForThisConsumer = partitionsPerConsumer + (c < extraPartitions ? 1 : 0);
          for (let i = 0; i < partitionsForThisConsumer; i++) {
            assignments[partitionIndex] = c;
            partitionIndex++;
          }
        }
        break;
        
      case 'roundrobin':
        // Round Robin: Assign partitions one by one to consumers
        for (let p = 0; p < numPartitions; p++) {
          assignments[p] = p % numConsumers;
        }
        break;
        
      case 'sticky':
        // Sticky: Try to keep existing assignments, minimize reassignments
        const unassignedPartitions = [];
        const consumerPartitionCounts = Array(numConsumers).fill(0);
        
        // First, try to keep existing assignments if consumer still exists
        for (let p = 0; p < numPartitions; p++) {
          const prevConsumer = prevAssignments[p];
          if (prevConsumer !== undefined && prevConsumer < numConsumers) {
            assignments[p] = prevConsumer;
            consumerPartitionCounts[prevConsumer]++;
          } else {
            unassignedPartitions.push(p);
          }
        }
        
        // Redistribute unassigned partitions to consumers with fewer partitions
        unassignedPartitions.forEach(partition => {
          const minConsumer = consumerPartitionCounts.indexOf(Math.min(...consumerPartitionCounts));
          assignments[partition] = minConsumer;
          consumerPartitionCounts[minConsumer]++;
        });
        
        // Balance if some consumers have too many partitions
        const targetPartitionsPerConsumer = Math.ceil(numPartitions / numConsumers);
        const overloadedConsumers = consumerPartitionCounts
          .map((count, consumer) => ({ consumer, count }))
          .filter(c => c.count > targetPartitionsPerConsumer);
          
        overloadedConsumers.forEach(({ consumer, count }) => {
          const excessPartitions = Object.keys(assignments)
            .filter(p => assignments[p] === consumer)
            .slice(targetPartitionsPerConsumer);
            
          excessPartitions.forEach(partition => {
            const underloadedConsumer = consumerPartitionCounts.indexOf(Math.min(...consumerPartitionCounts));
            assignments[partition] = underloadedConsumer;
            consumerPartitionCounts[consumer]--;
            consumerPartitionCounts[underloadedConsumer]++;
          });
        });
        break;
        
      default:
        // Fallback to round robin
        for (let p = 0; p < numPartitions; p++) {
          assignments[p] = p % numConsumers;
        }
    }
    
    return assignments;
  };

  const getConsumerForPartition = (partitionId) => {
    if (isRebalancing) return null; // No assignment during rebalancing
    return partitionAssignments[partitionId] ?? (partitionId % consumers);
  };

  const getConsumersForGroup = (groupId) => {
    return groupAssignments[groupId] || {};
  };

  // Add/remove consumer groups
  const addConsumerGroup = () => {
    const newGroupId = `service-${consumerGroups.length + 1}`;
    const colors = ['#ef4444', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];
    const newColor = colors[consumerGroups.length % colors.length];
    
    setConsumerGroups(prev => [...prev, {
      id: newGroupId,
      consumers: 1,
      color: newColor,
      filter: null
    }]);
  };

  const removeConsumerGroup = (groupId) => {
    if (consumerGroups.length > 1) {
      setConsumerGroups(prev => prev.filter(g => g.id !== groupId));
      setGroupAssignments(prev => {
        const newAssignments = { ...prev };
        delete newAssignments[groupId];
        return newAssignments;
      });
    }
  };

  const updateGroupConsumers = (groupId, count) => {
    setConsumerGroups(prev => prev.map(group => 
      group.id === groupId ? { ...group, consumers: count } : group
    ));
  };

  const updateGroupFilter = (groupId, filter) => {
    setConsumerGroups(prev => prev.map(group => 
      group.id === groupId ? { ...group, filter: filter || null } : group
    ));
  };

  // Trigger rebalancing when consumer count or strategy changes
  useEffect(() => {
    const totalConsumers = consumerGroups.reduce((sum, group) => sum + group.consumers, 0);
    const needsRebalancing = totalConsumers !== consumers || Object.keys(groupAssignments).length === 0;
    
    if (needsRebalancing) {
      setConsumers(totalConsumers);
      setIsRebalancing(true);
      setPreviousAssignments({ ...partitionAssignments });
      
      // Calculate assignments for each consumer group independently
      setTimeout(() => {
        const newGroupAssignments = {};
        
        consumerGroups.forEach(group => {
          const groupAssignment = calculateAssignments(
            rebalanceStrategy, 
            partitions, 
            group.consumers, 
            groupAssignments[group.id] || {}
          );
          
          newGroupAssignments[group.id] = groupAssignment;
        });
        
        // Set partition assignments from first group for partition display
        const firstGroupAssignments = Object.values(newGroupAssignments)[0] || {};
        
        setGroupAssignments(newGroupAssignments);
        setPartitionAssignments(firstGroupAssignments);
        
        setTimeout(() => {
          setIsRebalancing(false);
        }, 1000);
      }, 2000);
    }
  }, [consumerGroups, partitions, rebalanceStrategy]);

  // Trigger rebalancing when strategy changes (without changing consumer count)
  const handleStrategyChange = (newStrategy) => {
    if (newStrategy !== rebalanceStrategy) {
      setRebalanceStrategy(newStrategy);
      setIsRebalancing(true);
      setPreviousAssignments({ ...partitionAssignments });
      
      setTimeout(() => {
        const newAssignments = calculateAssignments(newStrategy, partitions, consumers, partitionAssignments);
        setPartitionAssignments(newAssignments);
        
        setTimeout(() => {
          setIsRebalancing(false);
        }, 1000);
      }, 2000);
    }
  };

  // Calculate throughput rates
  const getRecentThroughput = (history, windowSeconds = 10) => {
    const cutoff = Date.now() - (windowSeconds * 1000);
    const recentEntries = history.filter(entry => entry.timestamp > cutoff);
    const totalMessages = recentEntries.reduce((sum, entry) => sum + entry.count, 0);
    return totalMessages / windowSeconds;
  };

  // Initialize assignments on first load
  useEffect(() => {
    if (Object.keys(groupAssignments).length === 0) {
      const totalConsumers = consumerGroups.reduce((sum, group) => sum + group.consumers, 0);
      setConsumers(totalConsumers);
      
      const initialGroupAssignments = {};
      
      consumerGroups.forEach(group => {
        const groupAssignment = calculateAssignments(rebalanceStrategy, partitions, group.consumers, {});
        initialGroupAssignments[group.id] = groupAssignment;
      });
      
      setGroupAssignments(initialGroupAssignments);
      
      // Set partition assignments from first group for display
      if (Object.values(initialGroupAssignments)[0]) {
        setPartitionAssignments(Object.values(initialGroupAssignments)[0]);
      }
    }
  }, [partitions, consumerGroups, rebalanceStrategy]);

  return (
    <div className="w-full max-w-7xl mx-auto p-6 bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl shadow-2xl text-white">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2 flex items-center gap-3">
          <Zap className="text-yellow-400" />
          Kafka Topic Visualizer
        </h1>
        <p className="text-slate-300">Watch messages flow through partitions to consumer groups in real-time</p>
      </div>

      {/* Controls */}
      <div className="grid grid-cols-1 md:grid-cols-7 gap-4 mb-8 p-4 bg-slate-800/50 rounded-lg">
        <div>
          <label className="block text-sm font-medium mb-2 flex items-center gap-2">
            <Zap size={16} />
            Message Rate
          </label>
          <input
            type="range"
            min="0.5"
            max="10"
            step="0.5"
            value={messageRate}
            onChange={(e) => setMessageRate(parseFloat(e.target.value))}
            className="w-full accent-yellow-500"
          />
          <span className="text-sm text-slate-400">{messageRate} msg/s</span>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2 flex items-center gap-2">
            <Hash size={16} />
            Partitions
          </label>
          <input
            type="range"
            min="1"
            max="6"
            value={partitions}
            onChange={(e) => setPartitions(parseInt(e.target.value))}
            className="w-full accent-blue-500"
          />
          <span className="text-sm text-slate-400">{partitions}</span>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2 flex items-center gap-2">
            <Users size={16} />
            Consumer Groups
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">{consumerGroups.length} groups</span>
            <button
              onClick={addConsumerGroup}
              className="px-2 py-1 bg-green-600 hover:bg-green-700 rounded text-xs font-medium transition-colors"
            >
              + Add
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Processing Rate</label>
          <input
            type="range"
            min="0.1"
            max="1.5"
            step="0.1"
            value={processingRate}
            onChange={(e) => setProcessingRate(parseFloat(e.target.value))}
            className="w-full accent-purple-500"
          />
          <span className="text-sm text-slate-400">{Math.round(processingRate * 100)}%</span>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Rebalance Strategy</label>
          <select
            value={rebalanceStrategy}
            onChange={(e) => handleStrategyChange(e.target.value)}
            className="w-full p-2 bg-slate-700 rounded border border-slate-600 text-white text-sm"
            disabled={isRebalancing}
          >
            <option value="range">Range</option>
            <option value="roundrobin">Round Robin</option>
            <option value="sticky">Sticky</option>
          </select>
          <div className="text-xs text-slate-400 mt-1">
            {rebalanceStrategy === 'range' && 'Contiguous partitions per consumer'}
            {rebalanceStrategy === 'roundrobin' && 'Even distribution across consumers'}
            {rebalanceStrategy === 'sticky' && 'Minimize partition movement'}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Partition Key Template</label>
          <input
            type="text"
            value={partitionKeyTemplate}
            onChange={(e) => setPartitionKeyTemplate(e.target.value)}
            placeholder="e.g. account_id:record_id or user_id"
            className="w-full p-2 bg-slate-700 rounded border border-slate-600 text-white text-sm"
          />
          <div className="text-xs text-slate-400 mt-1">
            Use field names from message data
          </div>
        </div>

        <div className="flex items-end">
          <button
            onClick={() => setIsRunning(!isRunning)}
            className={`flex items-center gap-2 px-4 py-2 rounded font-medium transition-colors mr-2 ${
              isRunning 
                ? 'bg-red-600 hover:bg-red-700' 
                : 'bg-green-600 hover:bg-green-700'
            }`}
          >
            {isRunning ? <Pause size={16} /> : <Play size={16} />}
            {isRunning ? 'Pause' : 'Start'}
          </button>
          
          <button
            onClick={() => setShowOrderingDemo(!showOrderingDemo)}
            className={`flex items-center gap-2 px-3 py-2 rounded text-sm font-medium transition-colors ${
              showOrderingDemo
                ? 'bg-purple-600 hover:bg-purple-700'
                : 'bg-slate-600 hover:bg-slate-700'
            }`}
          >
            🔢 Ordering Demo
          </button>
        </div>
      </div>

      {/* Topic Visualization */}
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">Topic: user-events</h2>
          <div className="flex justify-center mb-4">
            <div className="bg-slate-700 px-4 py-2 rounded-full">
              Producer → Topic → Consumers
            </div>
          </div>
        </div>

        {/* Throughput Dashboard */}
        <div className="mb-6 grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-gradient-to-r from-blue-600/20 to-blue-500/20 rounded-lg p-4 border border-blue-500/30">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse"></div>
              <span className="text-sm font-medium text-blue-300">Producer Rate</span>
            </div>
            <div className="text-2xl font-bold text-white">
              {getRecentThroughput(throughputMetrics.producedHistory).toFixed(1)}
            </div>
            <div className="text-xs text-slate-400">msg/sec</div>
          </div>

          <div className="bg-gradient-to-r from-green-600/20 to-green-500/20 rounded-lg p-4 border border-green-500/30">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
              <span className="text-sm font-medium text-green-300">Consumer Rate</span>
            </div>
            <div className="text-2xl font-bold text-white">
              {getRecentThroughput(throughputMetrics.consumedHistory).toFixed(1)}
            </div>
            <div className="text-xs text-slate-400">msg/sec</div>
          </div>

          <div className="bg-gradient-to-r from-purple-600/20 to-purple-500/20 rounded-lg p-4 border border-purple-500/30">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 bg-purple-400 rounded-full"></div>
              <span className="text-sm font-medium text-purple-300">Total Produced</span>
            </div>
            <div className="text-2xl font-bold text-white">
              {throughputMetrics.produced.toLocaleString()}
            </div>
            <div className="text-xs text-slate-400">messages</div>
          </div>

          <div className="bg-gradient-to-r from-orange-600/20 to-orange-500/20 rounded-lg p-4 border border-orange-500/30">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 bg-orange-400 rounded-full"></div>
              <span className="text-sm font-medium text-orange-300">Total Consumed</span>
            </div>
            <div className="text-2xl font-bold text-white">
              {throughputMetrics.consumed.toLocaleString()}
            </div>
            <div className="text-xs text-slate-400">messages</div>
          </div>
        </div>

        {/* Message Ordering Visualization */}
        {showOrderingDemo && (
          <div className="mb-6 p-4 bg-purple-900/20 rounded-lg border border-purple-500/30">
            <h4 className="font-semibold text-purple-300 mb-3 flex items-center gap-2">
              🔢 Message Ordering Demonstration
            </h4>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Global Order */}
              <div className="bg-slate-800/50 rounded-lg p-3">
                <h5 className="font-medium text-slate-300 mb-2">Global Processing Order (Across All Partitions)</h5>
                <div className="text-xs text-slate-400 mb-2">
                  Messages as they're actually processed by consumers:
                </div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {messages
                    .filter(m => m.processedAt)
                    .sort((a, b) => a.processedAt - b.processedAt)
                    .slice(-10)
                    .map(msg => (
                      <div key={msg.id} className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-purple-300">G{msg.globalOrder}</span>
                        <span className="text-slate-400">→</span>
                        <span className="font-mono">P{msg.partition}:#{msg.offset}</span>
                        <span style={{ color: msg.color }} className="font-mono text-xs">
                          {msg.key.slice(0, 8)}...
                        </span>
                      </div>
                    ))}
                </div>
              </div>

              {/* Per-Partition Order */}
              <div className="bg-slate-800/50 rounded-lg p-3">
                <h5 className="font-medium text-slate-300 mb-2">Per-Partition Order (Guaranteed)</h5>
                <div className="text-xs text-slate-400 mb-2">
                  Within each partition, order is always preserved:
                </div>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {Array(partitions).fill().map((_, p) => {
                    const partitionMsgs = messages
                      .filter(m => m.partition === p && m.processedAt)
                      .sort((a, b) => a.offset - b.offset)
                      .slice(-3);
                    
                    return (
                      <div key={p} className="text-xs">
                        <div className="font-medium text-blue-300">Partition {p}:</div>
                        <div className="ml-2 space-y-1">
                          {partitionMsgs.map(msg => (
                            <div key={msg.id} className="flex items-center gap-2">
                              <span className="font-mono">#{msg.offset}</span>
                              <span className="text-slate-400">→</span>
                              <span className="font-mono text-purple-300">G{msg.globalOrder}</span>
                              <span style={{ color: msg.color }} className="font-mono text-xs">
                                {msg.key.slice(0, 6)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            
            <div className="mt-4 text-sm text-slate-400">
              <p><strong>Key Insight:</strong> Global order (G1, G2, G3...) shows production order, but processing happens 
              out-of-order across partitions. Within each partition (P0:#1, P0:#2), order is always preserved.</p>
            </div>
          </div>
        )}

        {/* Partitions */}
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${partitions}, 1fr)` }}>
          {Array(partitions).fill().map((_, i) => {
            const partitionMessages = getPartitionMessages(i);
            const assignedConsumer = getConsumerForPartition(i);
            const lag = consumerLag[i] || { count: 0, lagMs: 0 };
            const lagSeverity = lag.lagMs > 5000 ? 'high' : lag.lagMs > 2000 ? 'medium' : 'low';
            const partitionThroughput = getRecentThroughput(throughputMetrics.partitionThroughput[i] || []);
            
            return (
              <div key={i} className={`bg-slate-700/50 rounded-lg p-4 border transition-all duration-1000 ${
                isRebalancing ? 'border-orange-500 animate-pulse' :
                lagSeverity === 'high' ? 'border-red-500' : 
                lagSeverity === 'medium' ? 'border-yellow-500' : 
                'border-slate-600'
              }`}>
                <div className="text-center mb-3">
                  <h3 className="font-semibold text-blue-300">Partition {i}</h3>
                  <div className={`text-xs transition-all duration-1000 ${
                    isRebalancing ? 'text-orange-300 animate-bounce' : 'text-slate-400'
                  }`}>
                    {isRebalancing ? '⚡ Rebalancing...' : `→ Consumer ${assignedConsumer}`}
                    {!isRebalancing && previousAssignments[i] !== undefined && 
                     previousAssignments[i] !== assignedConsumer && (
                      <span className="text-blue-300 text-xs ml-1">
                        (was C{previousAssignments[i]})
                      </span>
                    )}
                  </div>
                  
                  {/* Throughput indicator */}
                  <div className="mt-1 text-xs text-cyan-300 font-medium">
                    {partitionThroughput.toFixed(1)} msg/s
                  </div>
                  
                  {/* Lag Indicator */}
                  {!isRebalancing && (
                    <div className={`mt-2 px-2 py-1 rounded text-xs font-medium transition-opacity duration-500 ${
                      lagSeverity === 'high' ? 'bg-red-600/30 text-red-300' :
                      lagSeverity === 'medium' ? 'bg-yellow-600/30 text-yellow-300' :
                      'bg-green-600/30 text-green-300'
                    }`}>
                      Lag: {lag.count} msgs ({(lag.lagMs / 1000).toFixed(1)}s)
                    </div>
                  )}
                  
                  {isRebalancing && (
                    <div className="mt-2 px-2 py-1 rounded text-xs font-medium bg-orange-600/30 text-orange-300 animate-pulse">
                      Processing paused
                    </div>
                  )}
                </div>
                
                <div className="space-y-2 min-h-[200px]">
                  {partitionMessages.slice(-8).map(msg => {
                    const processedGroups = Object.keys(msg.processedByGroups || {}).filter(g => msg.processedByGroups[g]);
                    const totalGroups = consumerGroups.length;
                    
                    // Check which groups should process this message (considering filters)
                    const eligibleGroups = consumerGroups.filter(group => {
                      if (!group.filter) return true;
                      const keyMatches = msg.key && msg.key.includes(group.filter);
                      const fieldMatches = Object.values(msg.messageData).some(value => 
                        String(value).includes(group.filter)
                      );
                      return keyMatches || fieldMatches;
                    });
                    
                    const eligibleGroupsProcessed = processedGroups.filter(groupId => 
                      eligibleGroups.some(g => g.id === groupId)
                    );
                    
                    return (
                      <div
                        key={msg.id}
                        className={`p-2 rounded text-xs transition-all duration-500 ${
                          eligibleGroupsProcessed.length === eligibleGroups.length
                            ? 'bg-slate-600 opacity-50' 
                            : 'shadow-lg animate-pulse'
                        }`}
                        style={{ 
                          backgroundColor: eligibleGroupsProcessed.length === eligibleGroups.length ? undefined : msg.color + '40',
                          borderLeft: `3px solid ${msg.color}`
                        }}
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex flex-col">
                            <div className="font-mono font-semibold">#{msg.offset}</div>
                            {showOrderingDemo && (
                              <div className="text-xs text-purple-300 font-bold">
                                G{msg.globalOrder}
                              </div>
                            )}
                          </div>
                          <div className="text-xs">
                            {eligibleGroupsProcessed.length}/{eligibleGroups.length}
                            {eligibleGroups.length > 0 && (
                              <div className="flex gap-1 mt-1">
                                {eligibleGroups.map(group => (
                                  <div 
                                    key={group.id}
                                    className={`w-2 h-2 rounded-full ${
                                      msg.processedByGroups[group.id] ? 'opacity-100' : 'opacity-20'
                                    }`}
                                    style={{ backgroundColor: group.color }}
                                    title={group.id}
                                  />
                                ))}
                              </div>
                            )}
                            {eligibleGroups.length < totalGroups && (
                              <div className="text-xs text-yellow-300 mt-1">
                                Filtered by {totalGroups - eligibleGroups.length} groups
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="font-mono text-slate-300">{msg.key}</div>
                        <div className="text-slate-400 text-xs mt-1">
                          {Object.entries(msg.messageData).slice(0, 2).map(([field, value]) => (
                            <div key={field} className={value.includes('acc_001') ? 'text-yellow-300 font-semibold' : ''}>
                              {field}: {value}
                            </div>
                          ))}
                        </div>
                        <div className="text-slate-500 text-xs">
                          {new Date(msg.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Consumer Groups */}
        <div className={`bg-slate-700/30 rounded-lg p-4 border transition-all duration-1000 ${
          isRebalancing ? 'border-orange-500 bg-orange-900/20' : 'border-slate-500'
        }`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className={`font-semibold flex items-center gap-2 transition-colors duration-500 ${
              isRebalancing ? 'text-orange-300' : 'text-green-300'
            }`}>
              <Users size={18} />
              Consumer Groups ({rebalanceStrategy.toUpperCase()})
              {isRebalancing && (
                <span className="text-xs bg-orange-600/50 px-2 py-1 rounded animate-pulse">
                  REBALANCING
                </span>
              )}
            </h3>
          </div>

          <div className="space-y-4">
            {consumerGroups.map((group, groupIndex) => (
              <div key={group.id} className={`bg-slate-600/30 rounded-lg p-3 border-l-4 transition-colors duration-500`} 
                   style={{ borderLeftColor: group.color }}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <h4 className="font-medium" style={{ color: group.color }}>
                      {group.id}
                      {group.filter && (
                        <span className="ml-2 text-xs bg-yellow-600/30 text-yellow-300 px-2 py-1 rounded">
                          Filter: {group.filter}
                        </span>
                      )}
                    </h4>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="1"
                        max="4"
                        value={group.consumers}
                        onChange={(e) => updateGroupConsumers(group.id, parseInt(e.target.value))}
                        className="w-16 accent-green-500"
                        disabled={isRebalancing}
                      />
                      <span className="text-xs text-slate-400">{group.consumers} consumers</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Filter (e.g. acc_001)"
                      value={group.filter || ''}
                      onChange={(e) => updateGroupFilter(group.id, e.target.value)}
                      className="w-32 px-2 py-1 bg-slate-700 border border-slate-600 rounded text-xs text-white"
                      disabled={isRebalancing}
                    />
                    {consumerGroups.length > 1 && (
                      <button
                        onClick={() => removeConsumerGroup(group.id)}
                        className="text-red-400 hover:text-red-300 text-xs px-2 py-1 hover:bg-red-600/20 rounded transition-colors"
                        disabled={isRebalancing}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${group.consumers}, 1fr)` }}>
                  {Array(group.consumers).fill().map((_, consumerIndex) => {
                    const groupAssignment = getConsumersForGroup(group.id);
                    const assignedPartitions = Object.entries(groupAssignment)
                      .filter(([, consumer]) => consumer === consumerIndex)
                      .map(([partition]) => parseInt(partition));
                    
                    const totalLag = assignedPartitions.reduce((sum, p) => {
                      const unprocessedInPartition = messages.filter(m => 
                        m.partition === p && !m.processedByGroups[group.id]
                      ).length;
                      return sum + unprocessedInPartition;
                    }, 0);
                    
                    const maxLagMs = Math.max(...assignedPartitions.map(p => {
                      const oldestUnprocessed = messages
                        .filter(m => m.partition === p && !m.processedByGroups[group.id])
                        .sort((a, b) => a.timestamp - b.timestamp)[0];
                      return oldestUnprocessed ? Date.now() - oldestUnprocessed.timestamp : 0;
                    }));
                    
                    const lagStatus = maxLagMs > 5000 ? 'critical' : maxLagMs > 2000 ? 'warning' : 'healthy';
                    const consumerThroughput = assignedPartitions.reduce((sum, p) => 
                      sum + getRecentThroughput(throughputMetrics.partitionThroughput[p] || []), 0);

                    // Get current offsets for this consumer's partitions
                    const partitionOffsets = assignedPartitions.map(p => ({
                      partition: p,
                      offset: groupOffsets[group.id]?.[p] || 0,
                      total: messages.filter(m => m.partition === p).length
                    }));

                    return (
                      <div key={consumerIndex} className={`bg-slate-700/50 rounded p-2 text-center text-xs transition-all duration-1000 ${
                        isRebalancing ? 'animate-pulse' : ''
                      }`}>
                        <div className="font-medium mb-1" style={{ color: group.color }}>
                          C{consumerIndex}
                        </div>
                        
                        {isRebalancing ? (
                          <div className="text-orange-300 animate-bounce">
                            ⚡ Rebalancing...
                          </div>
                        ) : (
                          <>
                            <div className="text-slate-400 mb-1">
                              P: {assignedPartitions.length > 0 ? assignedPartitions.join(',') : 'None'}
                            </div>
                            {partitionOffsets.length > 0 && (
                              <div className="text-xs text-slate-300 mb-1 space-y-1">
                                {partitionOffsets.map(({ partition, offset, total }) => (
                                  <div key={partition} className="flex justify-between">
                                    <span>P{partition}:</span>
                                    <span className="font-mono">{offset}/{total}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="text-cyan-300 font-medium mb-1">
                              {consumerThroughput.toFixed(1)}/s
                            </div>
                            <div className={`font-medium ${
                              lagStatus === 'critical' ? 'text-red-300' :
                              lagStatus === 'warning' ? 'text-yellow-300' :
                              'text-green-300'
                            }`}>
                              {totalLag} lag
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Multiple Consumer Groups Explanation */}
        <div className="mt-6 p-4 bg-slate-800/30 rounded-lg border border-slate-600">
          <h4 className="font-semibold text-slate-300 mb-2">Account-Specific Consumption Patterns</h4>
          <div className="text-sm text-slate-400 space-y-2">
            <p><strong>❌ Skip + Commit Anti-Pattern:</strong> Reading all messages but only processing matching account_id, 
            then committing offsets for skipped messages. This wastes bandwidth and processing power.</p>
            <p><strong>✅ Consumer-Level Filtering:</strong> Filter at consumer level but only commit offsets for processed messages. 
            The 'account-001-processor' group demonstrates this - it only processes acc_001 messages.</p>
            <p><strong>🎯 Better Alternatives:</strong> 
            • Partition by account_id and assign specific partitions to consumers
            • Use separate topics per account (events-account-001, events-account-002)
            • Use Kafka Streams for filtered topic creation</p>
            <p><strong>Notice:</strong> The filtered group processes faster (less data) and maintains independent offsets, 
            but still reads from the same partitions as other groups.</p>
          </div>
        </div>
        <div className="mb-6 p-4 bg-slate-800/30 rounded-lg border border-slate-600">
          <h4 className="font-semibold text-slate-300 mb-3">Message Fields & Partition Key Examples</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-slate-400 mb-1">Available Fields:</div>
              <div className="space-y-1">
                {Object.keys(messageFields).map(field => (
                  <div key={field} className="text-cyan-300 font-mono">{field}</div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-slate-400 mb-1">Examples:</div>
              <div className="space-y-1 font-mono text-xs">
                <div className="text-green-300">account_id</div>
                <div className="text-green-300">account_id:record_id</div>
                <div className="text-green-300">user_id</div>
                <div className="text-green-300">region:event_type</div>
              </div>
            </div>
            <div>
              <div className="text-slate-400 mb-1">Current Template:</div>
              <div className="font-mono text-yellow-300">{partitionKeyTemplate}</div>
            </div>
            <div>
              <div className="text-slate-400 mb-1">Sample Keys Generated:</div>
              <div className="space-y-1 text-xs">
                {Array(3).fill().map((_, i) => {
                  const sampleData = generateMessageData();
                  const sampleKey = extractPartitionKey(sampleData, partitionKeyTemplate);
                  return (
                    <div key={i} className="font-mono" style={{ color: getKeyColor(sampleKey) }}>
                      {sampleKey}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Message Field Configuration */}
        <div className="mt-6 p-4 bg-slate-800/30 rounded-lg border border-slate-600">
          <h4 className="font-semibold text-slate-300 mb-2">Current Strategy: {rebalanceStrategy.toUpperCase()}</h4>
          <div className="text-sm text-slate-400">
            {rebalanceStrategy === 'range' && (
              <p><strong>Range Strategy:</strong> Assigns contiguous blocks of partitions to consumers. 
              Consumer 0 gets partitions 0-1, Consumer 1 gets partitions 2-3, etc. Can lead to uneven load if partition traffic varies.</p>
            )}
            {rebalanceStrategy === 'roundrobin' && (
              <p><strong>Round Robin Strategy:</strong> Distributes partitions evenly across consumers in a round-robin fashion. 
              Better load distribution but doesn't consider existing assignments.</p>
            )}
            {rebalanceStrategy === 'sticky' && (
              <p><strong>Sticky Strategy:</strong> Tries to minimize partition reassignments during rebalancing. 
              Keeps existing assignments when possible, only moving partitions when necessary for balance.</p>
            )}
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-4 justify-center text-sm">
          <div className="text-slate-400">Recent partition key colors:</div>
          {[...new Set(messages.slice(-20).map(m => m.key))].slice(0, 8).map(key => (
            <div key={key} className="flex items-center gap-2">
              <div 
                className="w-3 h-3 rounded" 
                style={{ backgroundColor: getKeyColor(key) }}
              />
              <span className="font-mono text-xs">{key}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default App;
