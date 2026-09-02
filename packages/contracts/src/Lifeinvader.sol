// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Lifeinvader
/// @notice An ownerless, append-only event protocol for deliberately public social activity.
/// @dev The contract stores only monotonically increasing identifiers. Clients derive all social
///      state from canonical logs and must scope identifiers by chain ID and contract address.
contract Lifeinvader {
    enum ContentKind {
        Post,
        Comment
    }

    uint256 public constant MAX_BODY_BYTES = 4_096;
    uint256 public constant MAX_MEDIA_CID_BYTES = 128;
    uint256 public constant MAX_DISPLAY_NAME_BYTES = 64;
    uint256 public constant MAX_BIO_BYTES = 1_024;
    uint256 public constant MAX_GROUP_NAME_BYTES = 96;

    uint256 public nextPostId = 1;
    uint256 public nextCommentId = 1;
    uint256 public nextMessageId = 1;
    uint256 public nextGroupId = 1;

    error EmptyPayload();
    error BodyTooLarge(uint256 supplied, uint256 maximum);
    error MediaCidTooLarge(uint256 supplied, uint256 maximum);
    error DisplayNameTooLarge(uint256 supplied, uint256 maximum);
    error BioTooLarge(uint256 supplied, uint256 maximum);
    error EmptyGroupName();
    error GroupNameTooLarge(uint256 supplied, uint256 maximum);
    error UnknownPost(uint256 postId);
    error UnknownComment(uint256 commentId);
    error UnknownGroup(uint256 groupId);
    error ZeroAddress();
    error SelfFollow();

    event PostPublished(
        uint256 indexed postId, address indexed author, string body, bytes mediaCid
    );

    event CommentPublished(
        uint256 indexed commentId,
        uint256 indexed postId,
        address indexed author,
        string body,
        bytes mediaCid
    );

    event RepostPublished(uint256 indexed postId, address indexed account);

    event LikeSet(
        ContentKind indexed contentKind,
        uint256 indexed contentId,
        address indexed account,
        bool liked
    );

    event FollowSet(address indexed follower, address indexed followed, bool following);

    event ProfileSet(address indexed account, string displayName, string bio, bytes avatarCid);

    event DirectMessageSent(
        bytes32 indexed conversationId,
        address indexed sender,
        address indexed recipient,
        uint256 messageId,
        string body,
        bytes mediaCid
    );

    event GroupCreated(
        uint256 indexed groupId, address indexed creator, string name, bytes metadataCid
    );

    event GroupMembershipSet(uint256 indexed groupId, address indexed account, bool joined);

    event GroupMessageSent(
        uint256 indexed groupId,
        address indexed sender,
        uint256 indexed messageId,
        string body,
        bytes mediaCid
    );

    /// @notice Publishes text, a media manifest CID, or both.
    function publishPost(string calldata body, bytes calldata mediaCid)
        external
        returns (uint256 postId)
    {
        _validatePayload(body, mediaCid);

        postId = nextPostId;
        nextPostId = postId + 1;

        emit PostPublished(postId, msg.sender, body, mediaCid);
    }

    /// @notice Publishes a comment directly beneath an existing post.
    function publishComment(uint256 postId, string calldata body, bytes calldata mediaCid)
        external
        returns (uint256 commentId)
    {
        _requirePost(postId);
        _validatePayload(body, mediaCid);

        commentId = nextCommentId;
        nextCommentId = commentId + 1;

        emit CommentPublished(commentId, postId, msg.sender, body, mediaCid);
    }

    /// @notice Appends a repost action for an existing post.
    function publishRepost(uint256 postId) external {
        _requirePost(postId);
        emit RepostPublished(postId, msg.sender);
    }

    /// @notice Appends the caller's latest like state for a post or comment.
    function setLike(ContentKind contentKind, uint256 contentId, bool liked) external {
        if (contentKind == ContentKind.Post) {
            _requirePost(contentId);
        } else {
            _requireComment(contentId);
        }

        emit LikeSet(contentKind, contentId, msg.sender, liked);
    }

    /// @notice Appends the caller's latest follow state for another account.
    function setFollow(address followed, bool following) external {
        if (followed == address(0)) revert ZeroAddress();
        if (followed == msg.sender) revert SelfFollow();
        emit FollowSet(msg.sender, followed, following);
    }

    /// @notice Appends a complete public profile snapshot for the caller.
    function setProfile(string calldata displayName, string calldata bio, bytes calldata avatarCid)
        external
    {
        uint256 displayNameLength = bytes(displayName).length;
        if (displayNameLength > MAX_DISPLAY_NAME_BYTES) {
            revert DisplayNameTooLarge(displayNameLength, MAX_DISPLAY_NAME_BYTES);
        }

        uint256 bioLength = bytes(bio).length;
        if (bioLength > MAX_BIO_BYTES) revert BioTooLarge(bioLength, MAX_BIO_BYTES);
        _validateMediaCid(avatarCid);

        emit ProfileSet(msg.sender, displayName, bio, avatarCid);
    }

    /// @notice Sends a deliberately public direct message.
    /// @dev Both participants are indexed so inbox and outbox scans remain bounded and filterable.
    function sendDirectMessage(address recipient, string calldata body, bytes calldata mediaCid)
        external
        returns (uint256 messageId)
    {
        if (recipient == address(0)) revert ZeroAddress();
        _validatePayload(body, mediaCid);

        messageId = _takeMessageId();
        bytes32 directConversationId = conversationId(msg.sender, recipient);

        emit DirectMessageSent(
            directConversationId, msg.sender, recipient, messageId, body, mediaCid
        );
    }

    /// @notice Creates an immutable public group channel.
    function createGroup(string calldata name, bytes calldata metadataCid)
        external
        returns (uint256 groupId)
    {
        uint256 nameLength = bytes(name).length;
        if (nameLength == 0) revert EmptyGroupName();
        if (nameLength > MAX_GROUP_NAME_BYTES) {
            revert GroupNameTooLarge(nameLength, MAX_GROUP_NAME_BYTES);
        }
        _validateMediaCid(metadataCid);

        groupId = nextGroupId;
        nextGroupId = groupId + 1;

        emit GroupCreated(groupId, msg.sender, name, metadataCid);
    }

    /// @notice Appends the caller's latest membership signal for a public group.
    /// @dev Membership is social metadata, not an authorization gate; anyone can read or write.
    function setGroupMembership(uint256 groupId, bool joined) external {
        _requireGroup(groupId);
        emit GroupMembershipSet(groupId, msg.sender, joined);
    }

    /// @notice Sends a message to a public group channel.
    function sendGroupMessage(uint256 groupId, string calldata body, bytes calldata mediaCid)
        external
        returns (uint256 messageId)
    {
        _requireGroup(groupId);
        _validatePayload(body, mediaCid);

        messageId = _takeMessageId();
        emit GroupMessageSent(groupId, msg.sender, messageId, body, mediaCid);
    }

    /// @notice Computes the canonical identifier for a pair of direct-message participants.
    function conversationId(address firstAccount, address secondAccount)
        public
        pure
        returns (bytes32)
    {
        (address lower, address higher) = firstAccount < secondAccount
            ? (firstAccount, secondAccount)
            : (secondAccount, firstAccount);
        return keccak256(abi.encodePacked(lower, higher));
    }

    function _takeMessageId() private returns (uint256 messageId) {
        messageId = nextMessageId;
        nextMessageId = messageId + 1;
    }

    function _validatePayload(string calldata body, bytes calldata mediaCid) private pure {
        uint256 bodyLength = bytes(body).length;
        if (bodyLength == 0 && mediaCid.length == 0) revert EmptyPayload();
        if (bodyLength > MAX_BODY_BYTES) revert BodyTooLarge(bodyLength, MAX_BODY_BYTES);
        _validateMediaCid(mediaCid);
    }

    function _validateMediaCid(bytes calldata mediaCid) private pure {
        if (mediaCid.length > MAX_MEDIA_CID_BYTES) {
            revert MediaCidTooLarge(mediaCid.length, MAX_MEDIA_CID_BYTES);
        }
    }

    function _requirePost(uint256 postId) private view {
        if (postId == 0 || postId >= nextPostId) revert UnknownPost(postId);
    }

    function _requireComment(uint256 commentId) private view {
        if (commentId == 0 || commentId >= nextCommentId) revert UnknownComment(commentId);
    }

    function _requireGroup(uint256 groupId) private view {
        if (groupId == 0 || groupId >= nextGroupId) revert UnknownGroup(groupId);
    }
}
